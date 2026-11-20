/**
 * rangedRead — the authoritative half of `search({ content_range })`.
 *
 * A ranged read always re-fetches the source. Stored search chunks, FTS
 * snippets, and embedding chunk offsets are discovery evidence: they say "look
 * here", never "this is what it says". If a doc changed after the query that
 * surfaced it, the returned lines and `totalLines` reflect the content as it is
 * now: a ranged read can be quoted; a snippet cannot.
 *
 * Per-kind authoritative sources:
 *   doc     → public.docs.content        (raw Markdown, chips and transclusions byte-exact)
 *   message → public.messages.content    (current stored message text)
 *   memory  → public.memories.content    (key/owner stay OUT of the ranged body)
 *   file    → the file on disk           (project folder + relative_path)
 *
 * The `file` read carries the same guards the rest of the filesystem surface
 * uses: containment inside the project folder (resolveWithinFolder), the tool
 * root_dir constraint (validatePathConstraint), a size cap, and NUL-byte binary
 * rejection.
 */

import { readFile, stat } from 'node:fs/promises';
import { getDb } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import {
  MAX_EMBED_FILE_BYTES,
  MAX_EXTRACT_PDF_PAGES,
  MAX_EXTRACT_PDF_SOURCE_BYTES,
  isExtractableSourceFile,
  resolveWithinFolder,
} from '@server/services/embedding/fileSource';
import { extractPdfText } from '@server/services/pdfTextExtraction';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';
import {
  MAX_RANGED_FILE_BYTES,
  MAX_RANGED_ITEM_BYTES,
  MAX_RANGED_RESULTS,
  RANGED_CONTENT_KINDS,
  RangedResponseBudget,
  isRangedContentKind,
  sliceContentRange,
  type ContentRangeRequest,
  type RangedContent,
  type RangedContentKind,
} from './contentRange';

/**
 * Below this many spare bytes an item is omitted outright rather than rendered
 * as a useless sliver — a 40-byte fragment of line 12 is worse than an explicit
 * "omitted, budget exhausted".
 */
const MIN_RANGED_ITEM_BYTES = 512;

interface RangedItem {
  id: string;
  kind: RangedContentKind;
  /** Human label for the header: doc title, memory key, thread title, file path. */
  label: string;
  archived: boolean;
  ranged: RangedContent;
}

export type RangedReadResult =
  | { ok: true; item: RangedItem }
  /** `omitted` marks a budget skip (never a silent drop) rather than a real failure. */
  | { ok: false; error: string; omitted?: true };

interface RawSource {
  kind: RangedContentKind;
  label: string;
  content: string;
}

function unsupportedKindError(id: string, kind: string): string {
  return (
    `content_range is not supported for kind "${kind}" (id "${id}"). ` +
    `Ranged reads are available for: ${RANGED_CONTENT_KINDS.join(', ')}.`
  );
}

export async function loadDoc(id: string): Promise<RawSource | string> {
  const { rows } = await getDb().query<{ title: string | null; content: string | null }>(
    'SELECT d.title, d.content FROM public.docs d WHERE d.id = $1',
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → doc, but the doc row is missing.`;
  return { kind: 'doc', label: row.title || '(untitled doc)', content: row.content ?? '' };
}

async function loadMessage(id: string): Promise<RawSource | string> {
  const { rows } = await getDb().query<{ content: string | null; thread_title: string }>(
    `SELECT m.content, COALESCE(t.title, '(untitled thread)') AS thread_title
       FROM public.messages m
       JOIN public.threads t ON t.id = m.thread_id
      WHERE m.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → message, but the message row is missing.`;
  return { kind: 'message', label: row.thread_title, content: row.content ?? '' };
}

async function loadMemory(
  id: string,
  memoryScope: MemorySearchScope | null
): Promise<RawSource | string> {
  const { rows } = await getDb().query<{ memory_key: string | null; content: string | null }>(
    `SELECT m.memory_key, m.content FROM public.memories m
      WHERE m.id = $1 AND ${memoryScopeSql('m', 2, 3)}`,
    [id, ...memoryScopeParams(memoryScope)]
  );
  const row = rows[0];
  // Missing, or not the caller's to read: the same answer as a missing node,
  // so a ranged read never confirms that someone else's memory exists.
  if (!row) return `No node found for id "${id}".`;
  // The key is metadata ABOUT the memory, not part of its body — it belongs in
  // the header so line numbers refer to the content itself.
  return { kind: 'memory', label: row.memory_key || 'Memory', content: row.content ?? '' };
}

async function loadFile(
  id: string,
  settings: Record<string, unknown>
): Promise<RawSource | string> {
  const { rows } = await getDb().query<{
    relative_path: string;
    project_id: string;
    folder_path: string | null;
  }>(
    `SELECT f.relative_path, f.project_id, p.folder_path
       FROM public.files f
       LEFT JOIN public.containers p ON p.id = f.project_id AND p.category = 'project'
      WHERE f.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return `Resolved id "${id}" → file, but the file row is missing.`;
  if (!row.folder_path) {
    return `File "${row.relative_path}" (id "${id}") belongs to project ${row.project_id}, which has no folder configured; there is no authoritative file to read.`;
  }
  const absolute = resolveWithinFolder(row.folder_path, row.relative_path);
  if (!absolute) {
    return `File "${row.relative_path}" (id "${id}") resolves outside its project folder; refusing to read.`;
  }
  try {
    validatePathConstraint(absolute, settings);
  } catch (err) {
    return `File "${row.relative_path}" (id "${id}") is not readable: ${getErrorMessage(err)}`;
  }

  // Extractable documents (PDF): serve the same derived text layer the index
  // embeds, under the same caps, so the chunk offsets a search hit reports
  // land inside the content a ranged read returns. Raw-size cap matches the
  // indexing read (a bigger PDF was never indexed and has no offsets to chase).
  const extractable = isExtractableSourceFile(row.relative_path);

  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      return `File "${row.relative_path}" (id "${id}") is not a regular file.`;
    }
    size = info.size;
  } catch (err) {
    return `File "${row.relative_path}" (id "${id}") could not be read from disk: ${getErrorMessage(err)}`;
  }
  const sizeCap = extractable ? MAX_EXTRACT_PDF_SOURCE_BYTES : MAX_RANGED_FILE_BYTES;
  if (size > sizeCap) {
    return extractable
      ? `File "${row.relative_path}" (id "${id}") is ${size} bytes, over the ${sizeCap}-byte PDF extraction limit. Use the pdf_extract tool instead.`
      : `File "${row.relative_path}" (id "${id}") is ${size} bytes, over the ${sizeCap}-byte ranged-read limit. Use file(op:read) with start_line/end_line instead.`;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absolute);
  } catch (err) {
    return `File "${row.relative_path}" (id "${id}") could not be read from disk: ${getErrorMessage(err)}`;
  }
  if (extractable) {
    const extraction = await extractPdfText(buffer, {
      maxPages: MAX_EXTRACT_PDF_PAGES,
      maxChars: MAX_EMBED_FILE_BYTES,
    });
    if (!extraction.ok) {
      return extraction.reason === 'no-text'
        ? `File "${row.relative_path}" (id "${id}") is a PDF with no extractable text layer (scanned/image-only).`
        : `File "${row.relative_path}" (id "${id}") could not be parsed as a PDF${extraction.error ? `: ${extraction.error}` : ''}.`;
    }
    return {
      kind: 'file',
      label: `${row.relative_path} (extracted PDF text)`,
      content: extraction.text,
    };
  }
  // Same NUL-byte heuristic the embedding file reader uses, applied to the raw
  // bytes so a binary blob is rejected before a lossy utf-8 decode hides it.
  if (buffer.includes(0)) {
    return `File "${row.relative_path}" (id "${id}") is binary (contains NUL bytes); content_range supports text files only.`;
  }
  return { kind: 'file', label: row.relative_path, content: buffer.toString('utf8') };
}

/**
 * Re-read the current authoritative content for `id` and return only the
 * requested lines. `budget`, when supplied, bounds this item's contribution to
 * the whole response.
 */
export async function readRangedContentById(
  id: string,
  request: ContentRangeRequest,
  settings: Record<string, unknown> = {},
  budget?: RangedResponseBudget,
  memoryScope: MemorySearchScope | null = null
): Promise<RangedReadResult> {
  const available = budget ? budget.available() : MAX_RANGED_ITEM_BYTES;
  if (budget && available < MIN_RANGED_ITEM_BYTES) {
    budget.markExhausted();
    return {
      ok: false,
      omitted: true,
      error: `Omitted "${id}": the ranged-read response byte budget is exhausted. Re-request this id on its own.`,
    };
  }

  const { rows } = await getDb().query<{ type: string; archived: boolean | null }>(
    'SELECT type, archived FROM public.nodes WHERE id = $1',
    [id]
  );
  const node = rows[0];
  if (!node) return { ok: false, error: `No node found for id "${id}".` };
  if (!isRangedContentKind(node.type)) {
    return { ok: false, error: unsupportedKindError(id, node.type) };
  }

  let source: RawSource | string;
  switch (node.type) {
    case 'doc':
      source = await loadDoc(id);
      break;
    case 'message':
      source = await loadMessage(id);
      break;
    case 'memory':
      source = await loadMemory(id, memoryScope);
      break;
    default:
      source = await loadFile(id, settings);
      break;
  }
  if (typeof source === 'string') return { ok: false, error: source };

  const ranged = sliceContentRange(source.content, request, {
    maxBytes: Math.min(MAX_RANGED_ITEM_BYTES, available),
  });
  if (budget) budget.charge(Buffer.byteLength(ranged.content, 'utf8'));

  return {
    ok: true,
    item: {
      id,
      kind: source.kind,
      label: source.label,
      archived: node.archived === true,
      ranged,
    },
  };
}

/** Header line describing what was actually returned vs. what was asked for. */
function rangedHeader(item: RangedItem, request: ContentRangeRequest): string {
  const { startLine, endLine, totalLines, truncated } = item.ranged.range;
  const archived = item.archived ? ' [ARCHIVED]' : '';
  const prefix = `${item.kind} "${item.label}" (${item.id})${archived}`;
  if (endLine === 0) {
    return (
      `${prefix} — no lines: requested ${request.startLine}-${request.endLine}, ` +
      `content has ${totalLines} line(s).`
    );
  }
  const requested =
    startLine !== request.startLine || endLine !== request.endLine
      ? ` · requested ${request.startLine}-${request.endLine}`
      : '';
  return `${prefix} — lines ${startLine}-${endLine} of ${totalLines} · truncated: ${truncated}${requested}`;
}

/**
 * Render one ranged item. The body goes through the same neutralization every
 * other body-bearing search surface uses (see resolvers.ts): a ranged read
 * returns raw stored text, so it is exactly as attacker-reachable as
 * `detail: 'full'`. Neutralization only ever rewrites the reserved
 * `<system-reminder>` tag shape — Markdown, `[label](doc-…)` chips,
 * code fences, and every other byte pass through untouched.
 */
function renderRangedItem(item: RangedItem, request: ContentRangeRequest): string {
  const header = rangedHeader(item, request);
  if (item.ranged.content === '') return header;
  return `${header}\n${neutralizeSystemFraming(item.ranged.content)}`;
}

/** Render a whole ranged-read call: one block per id, input order preserved. */
function renderRangedResults(
  results: Array<{ id: string; result: RangedReadResult }>,
  request: ContentRangeRequest,
  budget: RangedResponseBudget,
  notes: string[] = []
): string {
  const blocks = results.map(({ id, result }) =>
    result.ok ? renderRangedItem(result.item, request) : `${id} — ${result.error}`
  );
  const header =
    `Ranged read (lines ${request.startLine}-${request.endLine}, 1-indexed inclusive) — ` +
    `${results.length} item(s). Content below is the CURRENT source, re-read now, not search evidence.`;
  const noteBlock = notes.length > 0 ? `\n${notes.map((n) => `Note: ${n}`).join('\n')}` : '';
  const footer = budget.wasExhausted()
    ? '\n\nResponse truncated: the ranged-read byte budget was exhausted. Re-request the omitted ids individually or narrow the range.'
    : '';
  return `${header}${noteBlock}\n\n${blocks.join('\n\n')}${footer}`;
}

/**
 * Exact-id ranged read — the PREFERRED path. Reads run in input order, one at a
 * time, because the shared byte budget is order-dependent: parallel reads would
 * make which item gets truncated non-deterministic.
 */
export async function runRangedRead(
  ids: string[],
  request: ContentRangeRequest,
  settings: Record<string, unknown> = {},
  notes: string[] = [],
  // Whose memories may be read (memoryScope.ts); none: no memory is.
  memoryScope: MemorySearchScope | null = null
): Promise<string> {
  const budget = new RangedResponseBudget();
  const results: Array<{ id: string; result: RangedReadResult }> = [];
  for (const id of ids) {
    results.push({
      id,
      result: await readRangedContentById(id, request, settings, budget, memoryScope),
    });
  }
  return renderRangedResults(results, request, budget, notes);
}

/** Minimal shape a search hit needs to be range-read. */
export interface RangeableHit {
  id: string;
  kind: string;
}

/**
 * Ranged section for a `query` + `content_range` call. The range is applied to
 * at most `MAX_RANGED_RESULTS` supported hits, in rank order; hits of an
 * unsupported kind and hits past the cap are named explicitly so the caller
 * never mistakes a bounded response for a complete one.
 *
 * Returns '' when no hit could be ranged at all.
 */
export async function rangedSectionForHits(
  hits: readonly RangeableHit[],
  request: ContentRangeRequest,
  settings: Record<string, unknown> = {},
  memoryScope: MemorySearchScope | null = null
): Promise<string> {
  const supported = hits.filter((hit) => isRangedContentKind(hit.kind));
  const unsupportedKinds = [
    ...new Set(hits.filter((h) => !isRangedContentKind(h.kind)).map((h) => h.kind)),
  ];
  const targets = supported.slice(0, MAX_RANGED_RESULTS);
  const overflow = supported.length - targets.length;

  const notes: string[] = [];
  if (overflow > 0) {
    notes.push(
      `${overflow} further rangeable result(s) were not read — content_range covers the top ${MAX_RANGED_RESULTS} only. Re-request them by id.`
    );
  }
  if (unsupportedKinds.length > 0) {
    notes.push(
      `Skipped kind(s) with no ranged content: ${unsupportedKinds.sort().join(', ')}. Ranged reads support ${RANGED_CONTENT_KINDS.join(', ')}.`
    );
  }
  if (targets.length === 0) {
    return notes.length > 0
      ? `Ranged read: no result in this response has ranged content.\n${notes.map((n) => `Note: ${n}`).join('\n')}`
      : '';
  }
  return runRangedRead(
    targets.map((hit) => hit.id),
    request,
    settings,
    notes,
    memoryScope
  );
}
