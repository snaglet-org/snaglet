/**
 * frontmatter — a deliberately small, hand-rolled YAML writer.
 *
 * No YAML dependency exists in this repo, and adding a general one would be
 * the wrong trade: a general emitter accepts arbitrary object graphs and makes
 * quoting decisions we would then have to audit. The set of shapes Snaglet actually
 * emits is tiny and fully under our control (scalars, scalar lists, and lists
 * of flat records), so the writer is restricted to exactly those.
 *
 * **Every string is quoted and escaped, unconditionally.** Emitting bare
 * scalars where they "look safe" means owning a predicate for when a string
 * would be reinterpreted as a number, a boolean, a date, `null`, or — the one
 * that matters — a nested YAML structure. A title of `: foo` or a name of
 * `- bar` is user-controlled input landing in a machine-read header. Quoting
 * unconditionally costs a few characters and removes that entire class.
 */

/** The only leaf types a Snaglet export puts in a header. */
type FrontmatterScalar = string | number | boolean | null;

/** One entry in a list-of-records (participants, compactions, runs). */
type FrontmatterRecord = Record<string, FrontmatterScalar>;

type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | readonly FrontmatterRecord[];

/** Insertion order is the emitted order — headers read top-down. */
export type Frontmatter = Record<string, FrontmatterValue | undefined>;

/**
 * Double-quoted YAML scalar. Escapes the two characters that would end or
 * extend the token, plus the control characters that would break the line
 * structure entirely. A newline inside a value becomes a literal `\n` so a
 * header entry can never span lines and can never introduce a forged key.
 */
export function quoteYamlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function scalar(value: FrontmatterScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // NaN/Infinity have no portable YAML spelling and always indicate a bug
    // upstream (a bad count, a divide by zero) — surfacing null is honest.
    return Number.isFinite(value) ? String(value) : 'null';
  }
  return quoteYamlString(value);
}

function isRecordList(value: readonly unknown[]): value is readonly FrontmatterRecord[] {
  return value.length > 0 && typeof value[0] === 'object' && value[0] !== null;
}

/**
 * Render `data` as a YAML frontmatter block, delimiters included.
 *
 * `undefined` values are omitted entirely — an absent key is honest, whereas
 * `key: null` asserts the field exists and is empty. Empty lists ARE emitted
 * (`[]`), because "this thread has no compactions" is a real answer.
 */
export function renderFrontmatter(data: Frontmatter): string {
  const lines: string[] = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      if (isRecordList(value)) {
        for (const record of value) {
          const entries = (
            Object.entries(record) as [string, FrontmatterScalar | undefined][]
          ).filter((pair): pair is [string, FrontmatterScalar] => pair[1] !== undefined);
          if (entries.length === 0) continue;
          // First pair carries the `-`, the rest align under it.
          entries.forEach(([k, v], index) => {
            lines.push(`${index === 0 ? '  - ' : '    '}${k}: ${scalar(v)}`);
          });
        }
      } else {
        for (const item of value as readonly FrontmatterScalar[]) {
          lines.push(`  - ${scalar(item)}`);
        }
      }
      continue;
    }

    lines.push(`${key}: ${scalar(value as FrontmatterScalar)}`);
  }

  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * Frontmatter followed by a markdown body.
 *
 * The body is emitted verbatim. It is not escaped, and it does not need to be:
 * a frontmatter block is only frontmatter at the very top of a file, so a
 * `---` appearing later in a doc is just a horizontal rule. The forgeable
 * construct in an export is the compaction boundary inside a transcript, which
 * is guarded where it is rendered (see transcript.ts) rather than here.
 */
export function withFrontmatter(data: Frontmatter, body: string): string {
  const trimmed = body.replace(/\s+$/, '');
  return trimmed ? `${renderFrontmatter(data)}\n${trimmed}\n` : renderFrontmatter(data);
}
