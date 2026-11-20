/**
 * SKILL.md reading and validation — pure helpers, no DB.
 *
 * A skill is a folder `<root>/<slug>/` holding `SKILL.md`:
 *
 *   ---
 *   name: Release checklist
 *   description: Steps to cut and verify a Snaglet release.
 *   ---
 *   (markdown body)
 *
 * Frontmatter follows the public Agent Skills format: `name` and `description`
 * are required, and every other top-level key (`license`, `allowed-tools`,
 * `metadata`, `version`, ...) is skipped unread, including its indented
 * lines, so skills from public repos load as-is. This is a small line reader,
 * not a YAML library: it understands top-level `key: value` lines, quoted
 * values, plain multi-line values and `|` / `>` block scalars, which covers
 * what skill files use. It stays lenient where strict YAML is not (an
 * unquoted colon inside a description is fine). Nothing here executes skill
 * content.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/*
 * SKILL.md has no length limit: `skill` op `load` returns a long file in
 * numbered parts (skillParts.ts), so nothing is cut at the tool-result ceiling.
 * Only the name and description are bounded, because every agent's system
 * prompt lists them.
 */
/**
 * A MEMORY GUARD, not an authoring limit: skills have no character limit. A
 * file is read whole into memory (to hash it, parse it, and split it into
 * parts), and the scanner re-reads SKILL.md on every watcher event, so a stray
 * huge file in a skill folder (a 400 MB asset) must be refused from its size
 * on disk before any byte of it is read. 8 MB is far past any real playbook.
 */
export const SKILL_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** `n` bytes as megabytes for a message, e.g. "8 MB" or "12.5 MB". */
export function formatMegabytes(n: number): string {
  const mb = n / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * The Agent Skills spec's own limit, so any spec-conformant description loads.
 * Every description is rendered into the system prompt's `## Skills` list, so
 * the cap also bounds that list (see SKILL_CATALOG_MAX_ENTRIES).
 */
export const SKILL_DESCRIPTION_MAX_CHARS = 1_024;
const SKILL_NAME_MAX_CHARS = 80;
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The only keys read; any other top-level key is ignored. */
const READ_KEYS = new Set(['name', 'description']);
/** `name:value` with no space after the colon, as the earlier reader allowed. */
const SIMPLE_KEY_LINE_RE = /^([A-Za-z_][\w-]*):(.*)$/;
/** Any other `key: value` line: the key ends at the first colon followed by space. */
const KEY_LINE_RE = /^(.+?):(?:\s+(.*))?$/;
/** A column-0 block sequence item: `- item`. */
const LIST_ITEM_RE = /^-(\s|$)/;
/** `|` or `>` with optional indentation (1-9) and chomping (+/-) indicators. */
const BLOCK_HEADER_RE = /^([|>])([1-9]?)([+-]?)([1-9]?)\s*(?:#.*)?$/;
/** A nested mapping line such as `author: someone`. */
const NESTED_KEY_RE = /^[A-Za-z_][\w-]*:(\s|$)/;

interface SkillFrontmatter {
  name: string;
  description: string;
  body: string;
}

export type SkillParseResult = { ok: true; value: SkillFrontmatter } | { ok: false; error: string };

/** One top-level key: the text after its colon plus its indented lines. */
interface FrontmatterEntry {
  key: string;
  inline: string;
  lines: string[];
}

type ScalarResult = { ok: true; value: string } | { ok: false; error: string };

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

/** YAML double-quoted escapes; `\x`, `\u` and `\U` are handled separately. */
const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: '\u00a0',
  L: '\u2028',
  P: '\u2029',
};

function isQuoted(value: string): boolean {
  return value.startsWith('"') || value.startsWith("'");
}

/**
 * Strip one pair of matching quotes and decode their escapes: `''` in single
 * quotes, and YAML's backslash escapes (including `\xXX`, `\uXXXX`,
 * `\UXXXXXXXX`) in double quotes. An unknown escape stays as written. A
 * trailing `\` line continuation is not special: the line break folds to a
 * space like any other, so the joined words keep a space between them.
 */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m, c: string) => {
        if (c.length === 1) return DOUBLE_QUOTED_ESCAPES[c] ?? m;
        const code = parseInt(c.slice(1), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : m;
      });
  }
  return v;
}

/** The key and inline value of a column-0 `key: value` line, or null. */
function parseKeyLine(line: string): { key: string; inline: string } | null {
  const simple = SIMPLE_KEY_LINE_RE.exec(line);
  if (simple) return { key: simple[1], inline: simple[2].trim() };
  const m = KEY_LINE_RE.exec(line);
  if (!m) return null;
  return { key: unquote(m[1]), inline: (m[2] ?? '').trim() };
}

/**
 * Split the frontmatter into top-level entries. A `key: value` line at column
 * 0 starts an entry, whatever the key looks like (`x.y`, `my key`, `"quoted"`);
 * indented lines, blank lines and `- item` lines belong to the key above them.
 * A `#` line at column 0 is a comment. A `- item` line after an inline value
 * (`name: a` then `- b`) is malformed YAML and an error.
 */
function splitEntries(
  block: string
): { ok: true; entries: FrontmatterEntry[] } | { ok: false; error: string } {
  const entries: FrontmatterEntry[] = [];
  for (const line of block.split('\n')) {
    const current = entries[entries.length - 1];
    if (current?.inline && LIST_ITEM_RE.test(line)) {
      const why = `a list item after the value of "${current.key}"`;
      return { ok: false, error: `Unsupported frontmatter line: ${line.slice(0, 60)} (${why})` };
    }
    const continues = line.trim() === '' || /^\s/.test(line) || LIST_ITEM_RE.test(line);
    if (continues) {
      if (current) current.lines.push(line);
      else if (line.trim() !== '') {
        return { ok: false, error: `Unsupported frontmatter line: ${line.slice(0, 60)}` };
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const keyLine = parseKeyLine(line);
    if (!keyLine) return { ok: false, error: `Unsupported frontmatter line: ${line.slice(0, 60)}` };
    entries.push({ ...keyLine, lines: [] });
  }
  return { ok: true, entries };
}

/**
 * YAML flow folding for plain and quoted values: line breaks become spaces
 * and each blank line becomes a newline.
 */
function foldFlow(parts: readonly string[]): string {
  let out = '';
  let breaks = 0;
  for (const part of parts) {
    const text = part.trim();
    if (text === '') {
      if (out) breaks++;
      continue;
    }
    if (out) out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    out += text;
    breaks = 0;
  }
  return out;
}

/**
 * A `|` (literal: keeps line breaks) or `>` (folded: joins lines with spaces,
 * keeps blank and more-indented lines as breaks) block scalar. Chomping
 * indicators are accepted; the caller trims the value, so they do not matter.
 */
function blockScalar(style: string, indentIndicator: string, lines: readonly string[]): string {
  const firstText = lines.find((l) => l.trim() !== '');
  if (firstText === undefined) return '';
  const indent = indentIndicator ? Number(indentIndicator) : leadingWhitespace(firstText);
  const content = lines.map((l) =>
    l.trim() === '' ? '' : l.slice(Math.min(indent, leadingWhitespace(l)))
  );
  if (style === '|') return content.join('\n');
  let out = '';
  content.forEach((line, i) => {
    const prev = content[i - 1];
    if (i === 0 || prev === '') out += line;
    else if (line === '') out += '\n';
    else if (/^\s/.test(line) || /^\s/.test(prev)) out += `\n${line}`;
    else out += ` ${line}`;
  });
  return out;
}

/**
 * The text value of `name` or `description`. A list or mapping (block or flow
 * style) is an error. `#` comment lines are dropped from plain values only;
 * inside quotes they are text.
 */
function scalarValue(entry: FrontmatterEntry): ScalarResult {
  const header = BLOCK_HEADER_RE.exec(entry.inline);
  if (header) {
    return { ok: true, value: blockScalar(header[1], header[2] || header[4], entry.lines).trim() };
  }
  const notText = {
    ok: false,
    error: `Frontmatter "${entry.key}" must be text, not a list or mapping`,
  } as const;
  const start = [entry.inline, ...entry.lines].find((l) => l.trim() !== '')?.trim() ?? '';
  if (isQuoted(start)) {
    return { ok: true, value: unquote(foldFlow([entry.inline, ...entry.lines])).trim() };
  }
  const rest = entry.lines.filter((l) => !l.trim().startsWith('#'));
  const first = rest.find((l) => l.trim() !== '')?.trim();
  if (
    !entry.inline &&
    first !== undefined &&
    (LIST_ITEM_RE.test(first) || NESTED_KEY_RE.test(first))
  ) {
    return notText;
  }
  const value = foldFlow([entry.inline, ...rest]);
  if (value.startsWith('[') || value.startsWith('{')) return notText;
  return { ok: true, value };
}

export function parseSkillMarkdown(raw: string): SkillParseResult {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return { ok: false, error: 'SKILL.md must start with a --- frontmatter block' };
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { ok: false, error: 'SKILL.md frontmatter is not closed with ---' };
  const afterFence = text.slice(end + 4);
  if (afterFence.length > 0 && !afterFence.startsWith('\n')) {
    return { ok: false, error: 'SKILL.md frontmatter is not closed with ---' };
  }
  const split = splitEntries(text.slice(4, end));
  if (!split.ok) return split;
  const fields: Record<string, string> = {};
  for (const entry of split.entries) {
    if (!READ_KEYS.has(entry.key)) continue;
    if (entry.key in fields) {
      return { ok: false, error: `Duplicate frontmatter key "${entry.key}"` };
    }
    const value = scalarValue(entry);
    if (!value.ok) return value;
    fields[entry.key] = value.value;
  }
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  for (const [key, value] of [
    ['name', name],
    ['description', description],
  ] as const) {
    if (value) continue;
    const near = split.entries.find((e) => e.key !== key && e.key.toLowerCase() === key);
    const hint = near ? ` (found "${near.key}"; keys are case-sensitive)` : '';
    return { ok: false, error: `Frontmatter needs a ${key}${hint}` };
  }
  if (name.length > SKILL_NAME_MAX_CHARS) {
    return { ok: false, error: `name is over ${SKILL_NAME_MAX_CHARS} characters` };
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `description is over ${SKILL_DESCRIPTION_MAX_CHARS} characters (${description.length})`,
    };
  }
  return { ok: true, value: { name, description, body: afterFence.replace(/^\n/, '') } };
}

export function hashSkillContent(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

export interface SkillFolderReadResult {
  slug: string;
  sourcePath: string;
  contentHash: string | null;
  name: string;
  description: string;
  status: 'valid' | 'invalid';
  error: string | null;
}

/** True when `child` is `parent` or inside it (both already realpath'd). */
export function isContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Read and validate `<root>/<slug>/SKILL.md`, returning its text too (null
 * when it could not be read). Both the folder and the file are resolved with
 * realpath and must stay inside the root's realpath, so a symlink cannot point
 * a skill at arbitrary files. A file over SKILL_FILE_MAX_BYTES is refused from
 * its size, unread. Never throws.
 */
export async function readSkillFolderText(
  rootDir: string,
  slug: string
): Promise<{ result: SkillFolderReadResult; text: string | null }> {
  const folder = path.join(rootDir, slug);
  const sourcePath = path.join(folder, 'SKILL.md');
  const invalid = (
    error: string,
    contentHash: string | null = null,
    text: string | null = null
  ): { result: SkillFolderReadResult; text: string | null } => ({
    result: {
      slug,
      sourcePath,
      contentHash,
      name: '',
      description: '',
      status: 'invalid',
      error,
    },
    text,
  });
  if (!SKILL_SLUG_RE.test(slug)) {
    return invalid('Folder name must be lowercase letters, digits, ".", "_" or "-" (max 64)');
  }
  let raw: string;
  try {
    const realRoot = await fs.realpath(rootDir);
    const realFolder = await fs.realpath(folder);
    const realFile = await fs.realpath(sourcePath);
    if (!isContained(realRoot, realFolder) || !isContained(realFolder, realFile)) {
      return invalid('SKILL.md resolves outside the skills folder (symlink escape)');
    }
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return invalid('SKILL.md is not a regular file');
    if (stat.size > SKILL_FILE_MAX_BYTES) {
      return invalid(
        `SKILL.md is over ${formatMegabytes(SKILL_FILE_MAX_BYTES)} (${formatMegabytes(stat.size)}); Snaglet does not read files that large.`
      );
    }
    raw = await fs.readFile(realFile, 'utf8');
  } catch (err) {
    return invalid(`Could not read SKILL.md: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  // Hashes the whole file, so a skill loaded in parts has one version.
  const contentHash = hashSkillContent(raw);
  const parsed = parseSkillMarkdown(raw);
  if (!parsed.ok) return invalid(parsed.error, contentHash, raw);
  return {
    result: {
      slug,
      sourcePath,
      contentHash,
      name: parsed.value.name,
      description: parsed.value.description,
      status: 'valid',
      error: null,
    },
    text: raw,
  };
}

/** Read and validate `<root>/<slug>/SKILL.md` (see readSkillFolderText). Never throws. */
export async function readSkillFolder(
  rootDir: string,
  slug: string
): Promise<SkillFolderReadResult> {
  return (await readSkillFolderText(rootDir, slug)).result;
}
