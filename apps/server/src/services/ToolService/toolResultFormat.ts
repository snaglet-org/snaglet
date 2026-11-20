/**
 * Tool-result formatting semantics shared by the result condensers
 * (`chatHelpers.condenseProcessedToolResults` and the `ContextWindowService`
 * compression path).
 *
 * These helpers let a condenser route by the originating tool's return type
 * instead of sniffing the result content. Content-sniffing would mis-classify
 * source code (full of `|` union types and `||`) as a delimited table and
 * show file contents to agents as bogus "[N rows returned, columns: …]" tables.
 */
import { isRecord, resolveToolId, safeJsonParse, toSnakeCase } from '@snaglet/shared/utils';

/**
 * Canonical tool ids whose results are free-form text (file contents, shell
 * output, TSV rows, search hits). Their output must never be structurally
 * re-rendered (tabular / JSON) by a condenser, only shortened as plain text.
 * Keyed by canonical id: callers resolve through `resolveToolId`, so alias ids
 * (`file_read`, `exec_command`, `shell_exec`, `write_stdin`, …) follow their
 * canonical tool automatically.
 */
export const VERBATIM_TEXT_TOOLS: ReadonlySet<string> = new Set([
  'file',
  'shell',
  // table(op): read returns TSV rows; the other ops return short text too.
  'table',
  'search',
  // skill(op:read) returns a supporting file's text; skill(op:load) results are
  // swapped for a fixed marker before this set is consulted.
  'skill',
]);

/**
 * Header line of a skill(op:load) result, written by `loadSkill`
 * (services/skills/skillTool.ts):
 * `[Skill <slug> · version <hash12> · …]`, or for a long skill loaded in parts
 * `[Skill <slug> · version <hash12> · part <n> of <total> · …]`. The optional
 * `(<scope>)` group matches older load headers still in history. op:read
 * results start `[Skill <slug> · <path>]` and do not match.
 */
const SKILL_LOAD_HEADER_RE =
  /^\[Skill ([a-z0-9][a-z0-9._-]{0,63}) (?:\([a-z]+\) )?· version ([0-9a-f]{8,})\b(?: · part (\d+) of (\d+))?/;

/**
 * A condensed skill(op:load) result is a fixed one-line marker,
 * never a summary of the skill body (a half-kept instruction set is worse than
 * none). A part keeps its number, so it is not mistaken for the whole skill.
 * Returns null for anything that is not a load result.
 */
export function skillLoadMarker(content: string): string | null {
  const m = SKILL_LOAD_HEADER_RE.exec(content.trimStart());
  if (!m) return null;
  const version = (m[2] ?? '').slice(0, 8);
  if (m[3]) {
    return `[skill ${m[1]} @${version} part ${m[3]} of ${m[4]} loaded — skill(op:load, part:${m[3]}) to reload]`;
  }
  return `[skill ${m[1]} @${version} loaded — skill(op:load) to reload]`;
}

/**
 * Canonical tools whose plain-text output carries its verdict at the end
 * (exit codes, errors, test summaries) — condensed with a tail share at least
 * as large as the head share.
 */
const TAIL_HEAVY_TOOLS: ReadonlySet<string> = new Set(['shell']);

/** Resolve a (possibly alias) tool id to its canonical catalog id. */
function canonicalToolId(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  return resolveToolId(toolName).id;
}

/**
 * Resolve the real tool id behind a `tool_use` block.
 *
 * Agents reach every tool through the single exposed `action` gateway
 * (see contextAssembly.ts), so a block's `name` is almost always `'action'`
 * with the real tool id carried in `input.tool` / `input.tool_name`. Returns
 * the block's own name for directly-listed tools (non-`action` paths), or
 * `undefined` when no name can be resolved.
 */
export function resolveEffectiveToolName(block: {
  name?: unknown;
  input?: unknown;
}): string | undefined {
  const name = typeof block.name === 'string' ? block.name : undefined;
  if (name?.startsWith('action__') && name.length > 'action__'.length) {
    return toSnakeCase(name.slice('action__'.length));
  }
  if (name && name !== 'action') return name;
  if (isRecord(block.input)) {
    const inner = block.input.tool ?? block.input.tool_name;
    if (typeof inner === 'string' && inner.trim()) return toSnakeCase(inner.trim());
  }
  return name;
}

/** True when the tool returns verbatim text that must not be coerced to a table. */
export function isVerbatimTextTool(toolName: string | undefined): boolean {
  const id = canonicalToolId(toolName);
  return id !== undefined && VERBATIM_TEXT_TOOLS.has(id);
}

/**
 * Render a compact but substantive preview of a JSON object result: each
 * top-level key with a short stringified preview of its value, truncated to
 * stay small.
 *
 * Collapsing JSON objects to bare key names with every value discarded — e.g.
 * `[JSON object with 11 keys: id, title, content, …]` — hides a doc's
 * actual title/content and forces callers to re-fetch via raw DB queries just
 * to see what a tool already returned. This keeps real content visible.
 */
function summarizeJsonObject(
  obj: Record<string, unknown>,
  maxKeys = 12,
  maxValueChars = 80
): string {
  const keys = Object.keys(obj);
  const previewKeys = keys.slice(0, maxKeys);
  const previewValue = (v: unknown): string => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') {
      const s = v.trim().replace(/\s+/g, ' ');
      return s.length > maxValueChars ? `"${s.slice(0, maxValueChars)}…"` : `"${s}"`;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[array: ${v.length} items]`;
    if (typeof v === 'object') return `{object: ${Object.keys(v).length} keys}`;
    return String(v);
  };
  const lines = previewKeys.map((k) => `  ${k}: ${previewValue(obj[k])}`);
  const header = `[JSON object with ${keys.length} key${keys.length === 1 ? '' : 's'}]`;
  const omitted =
    keys.length > previewKeys.length ? `\n  …${keys.length - previewKeys.length} more keys` : '';
  return [header, ...lines].join('\n') + omitted;
}

/**
 * Default char budget for the verbatim/plain-text condenser. Results at or
 * below this stay whole; larger ones are kept as head+tail. Tuned so the
 * common payloads survive a condense pass without a re-fetch — a config file's
 * `PORT=4001`, a function signature, the top+bottom of a source file.
 */
const DEFAULT_VERBATIM_CONDENSE_BUDGET = 2000;

/**
 * Payload-preserving condenser for verbatim / plain-text tool results. A short
 * head slice of a config or source file holds only its leading comments, so
 * agents would re-fetch the file again and again.
 *
 * A condensed result must retain enough substance that the agent does not need
 * to re-fetch for the common case. So instead of a bare head slice we keep a
 * head+tail window: the first ~`headFraction` and last ~`tailFraction` of the
 * budget, with a `[…N chars condensed…]` splice marker between them. Small
 * results (≤ budget) are returned unchanged.
 */
export function condenseVerbatimText(
  content: string,
  opts: { budget?: number; headFraction?: number; tailFraction?: number } = {}
): string {
  const budget = opts.budget ?? DEFAULT_VERBATIM_CONDENSE_BUDGET;
  const headFraction = opts.headFraction ?? 0.6;
  const tailFraction = opts.tailFraction ?? 0.25;

  // Small enough to keep whole — never condense below the full content.
  if (content.length <= budget) return content;

  const headChars = Math.max(0, Math.floor(budget * headFraction));
  const tailChars = Math.max(0, Math.floor(budget * tailFraction));

  // If head+tail would meet or overlap (tiny budget vs. content), keep whole
  // rather than emit a marker that "condenses" nothing useful.
  if (headChars + tailChars >= content.length) return content;

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const condensedChars = content.length - headChars - tailChars;
  return `${head}\n[…${condensedChars} chars condensed…]\n${tail}`;
}

/**
 * Shell-style tools return `{"output": "<text>"}`. Condensers must see the
 * text, not a one-key JSON object (which would summarize a whole shell run as
 * `[JSON object with 1 key]` + an 80-char preview). Anything else is returned
 * unchanged.
 */
export function unwrapOutputEnvelope(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"output"')) return content;
  const parsed = safeJsonParse<unknown>(trimmed);
  if (isRecord(parsed) && typeof parsed.output === 'string') {
    const keys = Object.keys(parsed);
    if (keys.length === 1) return parsed.output;
  }
  return content;
}

const isErrorEnvelope = (parsed: unknown): boolean =>
  isRecord(parsed) && ('error' in parsed || 'errors' in parsed || parsed.success === false);

/**
 * Is this tool result an error? Decides whether condensing keeps it whole
 * (live window) or flags it (digest).
 *
 * 1. The tool_result block's real `is_error` flag wins when it is `true`.
 * 2. Text tools (VERBATIM_TEXT_TOOLS) are never judged by content: a file
 *    that imports `getErrorMessage` or a test run printing `FAIL` is ordinary
 *    output, and must stay condensable — shell keeps its tail, where the
 *    real verdict is.
 * 3. Other tools: a JSON error envelope (`error`/`errors`/`success:false`)
 *    counts. The leading-80-chars keyword sniff only applies when no
 *    `is_error` flag is known (e.g. older persisted messages).
 */
export function isToolResultError(
  content: string,
  opts: { toolName?: string; isError?: boolean } = {}
): boolean {
  if (opts.isError === true) return true;
  const canonical = canonicalToolId(opts.toolName);
  if (canonical && VERBATIM_TEXT_TOOLS.has(canonical)) return false;

  const trimmed = unwrapOutputEnvelope(content).trim();
  if (trimmed.startsWith('{') && isErrorEnvelope(safeJsonParse<unknown>(trimmed))) return true;
  if (opts.isError === false) return false;
  const lower = trimmed.slice(0, 80).toLowerCase();
  return lower.includes('error') || lower.includes('failed') || lower.includes('exception');
}

interface DetectedTable {
  columns: string[];
  rows: string[];
}

/** `|---|:--|` (markdown) or `---+-----` (psql-style, as database_query emits). */
const MARKDOWN_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/;
const PSQL_SEPARATOR = /^-+(\+-+)+$/;

const splitPipeColumns = (line: string): string[] =>
  line
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);

/**
 * Detect a real delimited table. A stray `|` is not enough (source code
 * `a || b`, `git show --stat`'s `file | 8 ++` and prose all contain pipes),
 * so a pipe table needs a separator row under its header, and a TSV table
 * needs a tab-separated header with every row matching its column count.
 */
export function detectDelimitedTable(text: string): DetectedTable | null {
  const lines = text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const sepIdx = lines.findIndex(
    (l, i) => i > 0 && (MARKDOWN_SEPARATOR.test(l) || PSQL_SEPARATOR.test(l))
  );
  if (sepIdx > 0) {
    const columns = splitPipeColumns(lines[sepIdx - 1]);
    if (columns.length >= 2 && lines[sepIdx - 1].includes('|')) {
      const rows: string[] = [];
      for (const line of lines.slice(sepIdx + 1)) {
        if (!line.includes('|')) break;
        rows.push(line);
      }
      return { columns, rows };
    }
  }

  const header = lines[0].split('\t');
  if (header.length >= 2 && header.every((c) => c.trim())) {
    const body = lines.slice(1);
    if (body.every((l) => l.split('\t').length === header.length)) {
      return { columns: header.map((c) => c.trim()), rows: body };
    }
  }
  return null;
}

export interface SummarizeToolResultOptions {
  /** Canonical or alias id of the tool that produced the result. */
  toolName?: string;
  /**
   * Error results: `keep` returns them whole (live window — errors are critical
   * context); `flag` returns `ERROR: <preview>` (historical digest).
   */
  onError: 'keep' | 'flag';
  /** Plain-text condense budget (default: condenseVerbatimText's). */
  textBudget?: number;
  /** Data rows shown in a table preview (default 5). */
  previewRows?: number;
  /** The tool_result block's real `is_error` flag, when known. */
  isError?: boolean;
}

/**
 * The one structural summarizer for condensed tool results, shared by the live
 * window (`toolResultCondense`) and the folded-history digest
 * (`contextWindow/toolResultSummary`) so the two can't drift.
 *
 * Order: unwrap `{"output": …}` → errors (isToolResultError) → text tools stay text → real tables
 * → JSON → head+tail plain text (tail-heavy for shell, where exit codes land).
 */
export function summarizeToolResultContent(
  content: string,
  opts: SummarizeToolResultOptions
): string {
  const text = unwrapOutputEnvelope(content);
  const trimmed = text.trim();
  const flag = () =>
    opts.onError === 'keep'
      ? content
      : `ERROR: ${trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed}`;

  if (isToolResultError(content, { toolName: opts.toolName, isError: opts.isError })) {
    return flag();
  }

  const canonical = canonicalToolId(opts.toolName);
  // Unknown tool name too: some historical paths lose it, and the header is
  // specific enough that a load result must not fall through to table/JSON.
  if (canonical === 'skill' || canonical === undefined) {
    const marker = skillLoadMarker(text);
    if (marker !== null) return marker;
  }
  const structural = !(canonical && VERBATIM_TEXT_TOOLS.has(canonical));

  if (structural) {
    const table = detectDelimitedTable(trimmed);
    if (table) {
      const n = table.rows.length;
      const head = `[${n} rows returned, columns: ${table.columns.join(', ')}]`;
      const preview = table.rows.slice(0, opts.previewRows ?? 5);
      if (preview.length === 0) return head;
      return [
        head,
        `Preview (${preview.length}/${n}):`,
        ...preview,
        n > preview.length ? `[…${n - preview.length} more rows]` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Anything that is not valid JSON is condensed as plain text below.
      const parsed = safeJsonParse<unknown>(trimmed);
      if (Array.isArray(parsed)) {
        const first: unknown = parsed[0];
        const keys = isRecord(first) ? Object.keys(first).slice(0, 8).join(', ') : 'unknown';
        return `[JSON array: ${parsed.length} items, keys: ${keys}]`;
      }
      if (isRecord(parsed)) return summarizeJsonObject(parsed);
    }
  }

  const tailHeavy = canonical !== undefined && TAIL_HEAVY_TOOLS.has(canonical);
  return condenseVerbatimText(text, {
    budget: opts.textBudget,
    ...(tailHeavy ? { headFraction: 0.4, tailFraction: 0.5 } : {}),
  });
}
