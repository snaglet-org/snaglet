/**
 * Outbound workspace-reference validation.
 *
 * The terminal reply is parsed with the canonical markdown-reference parser plus
 * the existing bare-id grammar, and every referenced id is checked in one
 * nodes-table query. The database is the only authority: a reference is valid
 * if its node exists, is unarchived, and is the kind the reference claims.
 */

import { getDb } from '@snaglet/db/db';
import {
  idPrefixAlternation,
  LEGACY_ID_PREFIX,
  NODE_KIND,
} from '@snaglet/shared/constants/nodeKinds';
import { isToolId } from '@snaglet/shared/utils';
import { extractMarkdownRefs } from '@server/services/WorkspaceService/markdownRefs';

// Only kinds the linter can verify against the `nodes` table. `agent` is
// deliberately absent (agents are actors, not nodes — a lookup would
// false-flag every valid agent id) and `task` maps to doc via
// normalizeNodeType. Longer prefixes first: the extraction regex is not
// left-anchored.
const KIND_PREFIXES = [
  NODE_KIND.THREAD_SUMMARY,
  NODE_KIND.CONTAINER,
  NODE_KIND.MESSAGE,
  NODE_KIND.MEMORY,
  NODE_KIND.THREAD,
  NODE_KIND.IMAGE,
  LEGACY_ID_PREFIX.TASK,
  NODE_KIND.DOC,
] as const;

const KIND_ALT = KIND_PREFIXES.join('|');
const TIMESTAMP_BODY = '\\d{10,}-[A-Za-z0-9]+';
const UUID_BODY = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ID_BODY = `(?:${TIMESTAMP_BODY}|${UUID_BODY})`;
const PREFIXED_ID_RE = new RegExp(`^(${KIND_ALT})-(${ID_BODY})$`);
const LEGACY_BODY_RE = new RegExp(`^${ID_BODY}$`);
// Scheme form additionally accepts `page:` and `tool:` — schemes name a
// target type, not a verifiable prefix, so this set is wider than
// KIND_PREFIXES on purpose (normalizeNodeType folds page → doc).
const SCHEME_REF_RE = new RegExp(
  `^(${idPrefixAlternation([
    NODE_KIND.THREAD_SUMMARY,
    NODE_KIND.CONTAINER,
    NODE_KIND.MESSAGE,
    NODE_KIND.MEMORY,
    NODE_KIND.THREAD,
    NODE_KIND.IMAGE,
    LEGACY_ID_PREFIX.TASK,
    LEGACY_ID_PREFIX.PAGE,
    NODE_KIND.DOC,
    NODE_KIND.TOOL,
  ])}):(.+)$`
);

// Consume the left boundary so matchAll works at offset zero without lookbehind;
// reject a right-side id continuation so malformed partial tokens do not lint.
const NODE_ID_RE = new RegExp(
  `(?:^|[^a-zA-Z0-9_-])((${KIND_ALT})-(${ID_BODY}))(?![A-Za-z0-9_-])`,
  'g'
);

function normalizeNodeType(type: string): string {
  if (type === 'task' || type === 'page') return 'doc';
  return type;
}

/** Mask fenced code and Markdown quote lines. Inline code deliberately remains
 * active because agents commonly put delivered ids in backticks. Character
 * offsets remain stable for output rewriting. */
function maskQuotedAndFencedContent(text: string): string {
  let out = '';
  let inside = false;
  let i = 0;
  while (i < text.length) {
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(i, lineEnd);
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~');
    const isQuote = trimmed.startsWith('>');
    out += isFence || inside || isQuote ? ' '.repeat(line.length) : line;
    if (isFence) inside = !inside;
    if (lineEnd < text.length) out += '\n';
    i = lineEnd + 1;
  }
  return out;
}

export interface WorkspaceReference {
  id: string;
  nodeType: string;
  source: 'chip' | 'bare';
  index: number;
  length: number;
  label?: string;
}

function parseChipTarget(target: string): { id: string; nodeType: string } | null {
  const prefixed = PREFIXED_ID_RE.exec(target);
  if (prefixed) {
    return { id: target, nodeType: normalizeNodeType(prefixed[1]!) };
  }

  const scheme = SCHEME_REF_RE.exec(target);
  if (!scheme) return null;
  const declaredType = normalizeNodeType(scheme[1]!);
  const body = scheme[2]!;
  // Tool ids are name slugs. Built-in and workspace tools are registered via
  // `upsertTool`, which writes a `nodes` row of type 'tool' under the same id,
  // so the shared nodes lookup resolves them. A tool with no such row (an MCP
  // tool, or a row from the bare `POST /api/tools` create) reads as not found.
  if (scheme[1] === NODE_KIND.TOOL) {
    return isToolId(body) ? { id: body, nodeType: NODE_KIND.TOOL } : null;
  }
  if (LEGACY_BODY_RE.test(body)) return { id: body, nodeType: declaredType };
  if (PREFIXED_ID_RE.test(body)) return { id: body, nodeType: declaredType };
  return null;
}

/**
 * Parse the actual references emitted in a message. Markdown links reuse the
 * workspace markdown-reference parser; the bare-id pass uses the established strict id
 * grammar and skips every markdown-link span to avoid double counting hrefs.
 */
export function extractWorkspaceReferencesFromText(text: string): WorkspaceReference[] {
  if (!text) return [];
  const authoritativeText = maskQuotedAndFencedContent(text);
  const markdownHits = extractMarkdownRefs(authoritativeText);
  const markdownSpans = markdownHits.map((hit) => [hit.index, hit.index + hit.length] as const);
  const refs: WorkspaceReference[] = [];

  for (const hit of markdownHits) {
    const parsed = parseChipTarget(hit.targetId);
    if (!parsed) continue;
    refs.push({
      ...parsed,
      source: 'chip',
      index: hit.index,
      length: hit.length,
      label: hit.label,
    });
  }

  const haystack = authoritativeText;
  for (const match of haystack.matchAll(NODE_ID_RE)) {
    const id = match[1]!;
    const kind = match[2]!;
    const offsetInMatch = match[0].lastIndexOf(id);
    const index = (match.index ?? 0) + offsetInMatch;
    if (markdownSpans.some(([start, end]) => index >= start && index < end)) continue;
    refs.push({
      id,
      nodeType: normalizeNodeType(kind),
      source: 'bare',
      index,
      length: id.length,
    });
  }

  return refs.sort((a, b) => a.index - b.index);
}

/**
 * Canonical workspace chips/links only. Durable doc writes use this narrower
 * surface so ordinary prose containing an id-like token is never blocked.
 * Code fences and Markdown blockquotes are intentionally inert: copied or
 * quoted material is data, not an agent-authored workspace reference.
 */
export function extractCanonicalWorkspaceReferences(text: string): WorkspaceReference[] {
  if (!text) return [];
  const authoritativeText = maskQuotedAndFencedContent(text);
  const refs: WorkspaceReference[] = [];
  for (const hit of extractMarkdownRefs(authoritativeText)) {
    const parsed = parseChipTarget(hit.targetId);
    if (!parsed) continue;
    refs.push({
      ...parsed,
      source: 'chip',
      index: hit.index,
      length: hit.length,
      label: hit.label,
    });
  }
  return refs;
}

/** Existing raw-id extraction surface, retained for callers and focused tests. */
export function extractNodeIdsFromText(text: string): string[] {
  const ids = new Set<string>();
  for (const ref of extractWorkspaceReferencesFromText(text)) ids.add(ref.id);
  return [...ids];
}

type WorkspaceReferenceIssueReason = 'unverified' | 'not_found' | 'wrong_kind' | 'archived';

export interface WorkspaceReferenceIssue {
  id: string;
  nodeType: string;
  reason: WorkspaceReferenceIssueReason;
  actualType?: string;
}

export interface WorkspaceReferenceLintResult {
  content: string;
  issues: WorkspaceReferenceIssue[];
  infrastructureError: boolean;
}

interface NodeLookupRow {
  id: string;
  type: string;
  archived: boolean;
}

/**
 * A reference is verified by existence: the `row` argument comes from an
 * authoritative lookup against public.nodes, so if the node exists, is not
 * archived, and is the kind the reference claims, it renders normally.
 *
 * Deliberately not checked: which ids a tool returned this turn (an agent may
 * cite an id it created or read in an earlier turn), and project scope
 * (cross-project and root-level references are legitimate). A hallucinated id
 * has no row and still returns `not_found`; the check fires only when an id is
 * missing, archived, or the wrong kind.
 */
function issueForReference(
  ref: WorkspaceReference,
  row: NodeLookupRow | undefined
): WorkspaceReferenceIssue | null {
  if (!row) return { id: ref.id, nodeType: ref.nodeType, reason: 'not_found' };
  if (row.archived) return { id: ref.id, nodeType: ref.nodeType, reason: 'archived' };
  const actualType = normalizeNodeType(row.type);
  if (actualType !== ref.nodeType) {
    return {
      id: ref.id,
      nodeType: ref.nodeType,
      reason: 'wrong_kind',
      actualType,
    };
  }
  return null;
}

function issueSuffix(issue: WorkspaceReferenceIssue): string {
  if (issue.reason === 'not_found') return ' — not found';
  if (issue.reason === 'archived') return ' — archived';
  if (issue.reason === 'wrong_kind') {
    return ` — expected ${issue.nodeType}, found ${issue.actualType ?? 'unknown'}`;
  }
  return '';
}

function rewriteOffendingReferences(
  text: string,
  refs: readonly WorkspaceReference[],
  issueByRef: ReadonlyMap<WorkspaceReference, WorkspaceReferenceIssue>
): string {
  let out = '';
  let cursor = 0;
  for (const ref of refs) {
    const issue = issueByRef.get(ref);
    if (!issue) continue;
    out += text.slice(cursor, ref.index);
    const marker = `[unverified: ${ref.id}${issueSuffix(issue)}]`;
    out += ref.source === 'chip' && ref.label ? `${ref.label} ${marker}` : marker;
    cursor = ref.index + ref.length;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Validate all message refs with one lookup. Database failures deliberately
 * fail open: the original message is returned unchanged and no corrective
 * prompt is emitted by the caller.
 */
async function lintWorkspaceReferences(
  text: string,
  refs: readonly WorkspaceReference[]
): Promise<WorkspaceReferenceLintResult> {
  if (refs.length === 0) return { content: text, issues: [], infrastructureError: false };

  const ids = [...new Set(refs.map((ref) => ref.id))];
  let rows: NodeLookupRow[];
  try {
    const result = await getDb().query<NodeLookupRow>(
      'SELECT id, type, archived FROM public.nodes WHERE id = ANY($1::text[])',
      [ids]
    );
    rows = result.rows;
  } catch {
    return { content: text, issues: [], infrastructureError: true };
  }

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const issueByRef = new Map<WorkspaceReference, WorkspaceReferenceIssue>();
  const uniqueIssues = new Map<string, WorkspaceReferenceIssue>();
  for (const ref of refs) {
    const issue = issueForReference(ref, rowById.get(ref.id));
    if (!issue) continue;
    issueByRef.set(ref, issue);
    uniqueIssues.set(`${issue.id}\u0000${issue.nodeType}\u0000${issue.reason}`, issue);
  }

  return {
    content: rewriteOffendingReferences(text, refs, issueByRef),
    issues: [...uniqueIssues.values()],
    infrastructureError: false,
  };
}

export async function lintWorkspaceReferencesInMessage(
  text: string
): Promise<WorkspaceReferenceLintResult> {
  return lintWorkspaceReferences(text, extractWorkspaceReferencesFromText(text));
}

export async function lintCanonicalWorkspaceReferencesInContent(
  text: string
): Promise<WorkspaceReferenceLintResult> {
  return lintWorkspaceReferences(text, extractCanonicalWorkspaceReferences(text));
}
