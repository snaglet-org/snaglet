/**
 * sentenceSegmenter — turn a stream of assistant text deltas into complete
 * "speakable segments" for the TTS pipeline.
 *
 * The voice pipeline speaks on the first finished sentence, so this must emit a
 * sentence the moment it is unambiguously complete (terminator + following
 * whitespace) without waiting for a newline or the end of the turn. Structured
 * blocks — fenced code, markdown tables, bullet/ordered lists — are not spoken
 * verbatim; they are grouped and emitted as single block segments so the
 * downstream {@link speakabilityFilter} can replace them with a short spoken
 * placeholder. Because those blocks become placeholders anyway, holding them
 * until they close costs no perceived latency, while prose emits eagerly.
 *
 * The segmenter is a small deterministic state machine (streaming buffer + fence
 * state). `push(delta)` returns whatever segments completed; `flush()` drains
 * the tail at end-of-turn. The one-shot {@link segmentText} runs the same logic
 * over a complete string (used in tests and any non-streaming caller).
 *
 * A "segment" is a `{ text, kind }` pair; `kind` is the segmenter's structural
 * hint (`sentence | code | table | list`). The filter makes the final speak/
 * skip decision — the segmenter only groups.
 */

type SegmentKind = 'sentence' | 'code' | 'table' | 'list';

export interface TextSegment {
  /** Raw segment text (block segments keep their original markdown). */
  readonly text: string;
  /** Structural classification the filter refines. */
  readonly kind: SegmentKind;
}

/** Abbreviations whose trailing period must not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'al',
  'inc',
  'ltd',
  'co',
  'corp',
  'dept',
  'univ',
  'gen',
  'sen',
  'rep',
  'gov',
  'col',
  'capt',
  'sgt',
  'lt',
  'cmdr',
  'approx',
  'apt',
  'no',
  'vol',
  'fig',
  'eg',
  'ie',
  'ex',
  'cf',
  'pp',
  'ph',
  'esp',
  'min',
  'max',
  'sec',
]);

const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const LIST_LINE = /^[ \t]*([-*+]|\d+[.)])[ \t]+\S/;
/** A line that participates in a markdown table (has a pipe cell). */
const TABLE_LINE = /\|/;

function fenceMarkerOf(line: string): string | null {
  const m = line.match(FENCE_LINE);
  if (!m) return null;
  // Normalize to the run of fence chars only (``` or ~~~, possibly longer).
  const run = line.trimStart().match(/^(`{3,}|~{3,})/);
  return run ? run[1] : null;
}

function isFenceCloser(line: string, openMarker: string): boolean {
  const marker = fenceMarkerOf(line);
  if (!marker) return false;
  // Same fence char, at least as long, and nothing but the marker on the line.
  const fenceChar = openMarker[0];
  return marker[0] === fenceChar && marker.length >= openMarker.length && line.trim() === marker;
}

type LineType = 'blank' | 'list' | 'table' | 'prose';

function classifyLine(line: string): LineType {
  if (line.trim() === '') return 'blank';
  if (LIST_LINE.test(line)) return 'list';
  if (TABLE_LINE.test(line)) return 'table';
  return 'prose';
}

/** True if a still-growing final line could turn into a block (hold it). */
function mightStartBlock(partial: string): boolean {
  const t = partial.trimStart();
  if (t === '') return false;
  // A lone leading fence/bullet/pipe char, or a partial fence, could grow.
  return (
    /^(`{1,}|~{1,})/.test(t) ||
    /^([-*+]|\d+[.)]?)$/.test(t) ||
    /^([-*+]|\d+[.)])[ \t]*$/.test(t) ||
    TABLE_LINE.test(t)
  );
}

/**
 * Split a prose string into complete sentences, honoring abbreviations and
 * decimals. Returns the finished sentences plus the unterminated tail. When
 * `atEnd` is true the tail (if any non-whitespace) becomes a final sentence.
 */
function splitSentences(input: string, atEnd: boolean): { sentences: string[]; tail: string } {
  const sentences: string[] = [];
  let start = 0;
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      // Consume a run of terminators (?!, ..., !!, ?…).
      let j = i;
      while (j + 1 < n && '.!?…'.includes(input[j + 1])) j++;
      const after = j + 1 < n ? input[j + 1] : '';
      const isDot = input[i] === '.';

      // Decimal like 3.14 — digit before and digit after a lone dot.
      if (isDot && i > 0 && /\d/.test(input[i - 1]) && /\d/.test(after)) {
        i = j + 1;
        continue;
      }

      const boundaryConfirmed = after === '' ? atEnd : /\s/.test(after);
      if (!boundaryConfirmed) {
        i = j + 1;
        continue;
      }

      // Abbreviation guard: examine the word ending just before the terminator.
      if (isDot) {
        const wordMatch = input.slice(start, i).match(/([A-Za-z][A-Za-z.]*)$/);
        const word = wordMatch ? wordMatch[1].toLowerCase().replace(/\.$/, '') : '';
        const bare = word.replace(/\./g, '');
        const isInitial = /^[a-z]$/.test(bare); // single letter, e.g. "J."
        const isAcronym = /^([a-z]\.)+[a-z]?$/.test(word + '.'); // U.S. e.g.
        if (
          after !== '' && // never hold an abbreviation at the very end when atEnd
          (ABBREVIATIONS.has(bare) || isInitial || isAcronym)
        ) {
          i = j + 1;
          continue;
        }
      }

      const sentence = input.slice(start, j + 1).trim();
      if (sentence) sentences.push(sentence);
      // Skip trailing whitespace to the next sentence start.
      let k = j + 1;
      while (k < n && /\s/.test(input[k])) k++;
      start = k;
      i = k;
      continue;
    }
    i++;
  }

  let tail = input.slice(start);
  if (atEnd) {
    const t = tail.trim();
    if (t) sentences.push(t);
    tail = '';
  }
  return { sentences, tail };
}

/**
 * Segment a fully-delimited prose region (no fences) into sentence/list/table
 * segments. `final` means the region is complete (emit everything); otherwise
 * an open trailing list/table run or partial sentence is returned as `rest`.
 */
function segmentProse(text: string, final: boolean): { segments: TextSegment[]; rest: string } {
  const segments: TextSegment[] = [];
  if (text === '') return { segments, rest: '' };

  // Build line records with absolute offsets so `rest` is exact raw text.
  interface LineRec {
    text: string;
    start: number;
    end: number;
    hasNL: boolean;
  }
  const lines: LineRec[] = [];
  {
    let pos = 0;
    while (pos < text.length) {
      const nl = text.indexOf('\n', pos);
      if (nl === -1) {
        lines.push({ text: text.slice(pos), start: pos, end: text.length, hasNL: false });
        break;
      }
      lines.push({ text: text.slice(pos, nl), start: pos, end: nl, hasNL: true });
      pos = nl + 1;
    }
  }

  const emitRun = (recs: LineRec[], type: 'list' | 'table'): void => {
    if (recs.length === 0) return;
    const block = text.slice(recs[0].start, recs[recs.length - 1].end);
    // A lone pipe line is almost always prose, not a table — speak it.
    if (type === 'table' && recs.length < 2) {
      const { sentences } = splitSentences(block, true);
      for (const s of sentences) segments.push({ text: s, kind: 'sentence' });
      return;
    }
    segments.push({ text: block.replace(/\s+$/, ''), kind: type });
  };

  let runType: 'list' | 'table' | null = null;
  let run: LineRec[] = [];
  let consumedEnd = 0; // absolute offset consumed so far
  let heldFrom = -1; // if >=0, everything from here is held (rest)

  const closeRun = () => {
    if (runType) {
      emitRun(run, runType);
      runType = null;
      run = [];
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const L = lines[idx];
    const complete = L.hasNL || final;
    if (!complete) {
      // Incomplete trailing line — handle after the loop.
      break;
    }
    const type = classifyLine(L.text);

    if (type === 'list' || type === 'table') {
      if (runType === type) {
        run.push(L);
      } else {
        closeRun();
        consumedEnd = L.start;
        runType = type;
        run = [L];
      }
      consumedEnd = L.end + (L.hasNL ? 1 : 0);
      continue;
    }

    // prose or blank terminates any open run.
    closeRun();
    consumedEnd = L.start;
    if (type === 'blank') {
      consumedEnd = L.end + (L.hasNL ? 1 : 0);
      continue;
    }
    const { sentences } = splitSentences(L.text, true);
    for (const s of sentences) segments.push({ text: s, kind: 'sentence' });
    consumedEnd = L.end + (L.hasNL ? 1 : 0);
  }

  // Trailing handling.
  const lastIdx = lines.length - 1;
  const lastIncomplete =
    lines.length > 0 && !lines[lastIdx].hasNL && !final ? lines[lastIdx] : null;

  if (final) {
    closeRun();
    return { segments, rest: '' };
  }

  // Not final:
  if (runType) {
    // Open run reaches the current end (possibly continued by the incomplete
    // line) — hold it entirely for the next drain.
    heldFrom = run[0].start;
    return { segments, rest: text.slice(heldFrom) };
  }

  if (lastIncomplete) {
    const partial = text.slice(lastIncomplete.start);
    if (mightStartBlock(partial)) {
      return { segments, rest: partial };
    }
    const { sentences, tail } = splitSentences(partial, false);
    for (const s of sentences) segments.push({ text: s, kind: 'sentence' });
    return { segments, rest: tail };
  }

  return { segments, rest: text.slice(consumedEnd) };
}

export interface SentenceSegmenter {
  /** Feed a text delta; returns any segments that completed. */
  push(delta: string): TextSegment[];
  /** End of turn: drain the buffered tail. */
  flush(): TextSegment[];
  /** Discard buffered state (e.g. on barge-in / abort). */
  reset(): void;
}

/** Create a stateful streaming segmenter. */
export function createSentenceSegmenter(): SentenceSegmenter {
  let buffer = '';
  let inFence = false;
  let fenceMarker = '';

  const drain = (final: boolean): TextSegment[] => {
    const out: TextSegment[] = [];

    // Iterate until no more can be emitted this pass.
    for (;;) {
      if (inFence) {
        const closeIdx = findFenceClose(buffer, fenceMarker);
        if (closeIdx === -1) {
          if (final) {
            const block = buffer.replace(/\s+$/, '');
            if (block) out.push({ text: block, kind: 'code' });
            buffer = '';
            inFence = false;
          }
          break; // hold: wait for the closing fence
        }
        const block = buffer.slice(0, closeIdx).replace(/\s+$/, '');
        out.push({ text: block, kind: 'code' });
        buffer = buffer.slice(closeIdx);
        inFence = false;
        continue;
      }

      const opener = findFenceOpen(buffer);
      if (opener === null) {
        const { segments, rest } = segmentProse(buffer, final);
        out.push(...segments);
        buffer = rest;
        break;
      }

      // Emit the prose region before the fence, then enter fence mode.
      const region = buffer.slice(0, opener.lineStart);
      if (region) {
        const { segments } = segmentProse(region, true);
        out.push(...segments);
      }
      buffer = buffer.slice(opener.lineStart);
      inFence = true;
      fenceMarker = opener.marker;
      // loop to try closing the fence
    }

    return out;
  };

  return {
    push(delta: string): TextSegment[] {
      buffer += delta;
      return drain(false);
    },
    flush(): TextSegment[] {
      return drain(true);
    },
    reset(): void {
      buffer = '';
      inFence = false;
      fenceMarker = '';
    },
  };
}

/**
 * Find a fence-opener line. Returns the offset of the line's start and the
 * fence marker, or null. Only considers a line "seen" if it is terminated by a
 * newline OR it is clearly a complete fence marker line already.
 */
function findFenceOpen(buffer: string): { lineStart: number; marker: string } | null {
  let pos = 0;
  while (pos < buffer.length) {
    const nl = buffer.indexOf('\n', pos);
    const lineEnd = nl === -1 ? buffer.length : nl;
    const line = buffer.slice(pos, lineEnd);
    const marker = fenceMarkerOf(line);
    if (marker) {
      // Require the opener line to be terminated (we know it's a full fence line)
      // OR unmistakably a fence already (has the marker). A bare partial like
      // "``" won't match FENCE_LINE, so any match here is a real fence.
      return { lineStart: pos, marker };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null;
}

/**
 * Find the index just past a fence-closer line in `buffer`, or -1. Skips the
 * opener line (the fence's first line) before searching.
 */
function findFenceClose(buffer: string, marker: string): number {
  // Skip the opener line.
  const firstNl = buffer.indexOf('\n');
  if (firstNl === -1) return -1; // opener line not even finished
  let pos = firstNl + 1;
  while (pos <= buffer.length) {
    const nl = buffer.indexOf('\n', pos);
    const lineEnd = nl === -1 ? buffer.length : nl;
    const line = buffer.slice(pos, lineEnd);
    if (isFenceCloser(line, marker)) {
      // Consume through the newline if present.
      return nl === -1 ? buffer.length : nl + 1;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return -1;
}

/** One-shot: segment a complete string (non-streaming callers + tests). */
export function segmentText(text: string): TextSegment[] {
  const seg = createSentenceSegmenter();
  return [...seg.push(text), ...seg.flush()];
}
