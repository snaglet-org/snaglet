/**
 * Query-aware re-ranking for `tool(op:search)`.
 *
 * Retrieval (semantic + keyword + live-MCP lexical, fused by RRF) decides WHICH
 * tools are candidates. This module decides the ORDER agents see, using
 * evidence retrieval cannot weigh:
 *
 *   - exact identity: the query IS the tool (`create event` ⇢ `create_event`)
 *   - verb agreement: "delete the event" wants `delete_event`, not `get_event`
 *   - object evidence: a hit in id/name/keywords/aliases is an author's claim
 *     about what the tool is for; a hit only in description prose is a mention
 *   - weak incidental matches: a provider tool that merely contains a few of
 *     the query's words in its description must not beat a first-party tool
 *     built for the capability
 *   - a first-party prior that only decides genuine near-ties
 *
 * The retrieval score stays the base of every score (normalized to the pool's
 * best), so when a query carries no verb/object evidence the order is exactly
 * retrieval's. Every bonus and penalty is recorded as a short stable reason
 * tag so `explain: true` callers and the debug log can see why a tool ranked
 * where it did.
 *
 * Pure: no I/O, no DB, deterministic for identical input.
 */

import { tokenizeQuery } from '@snaglet/db/tables/tools';

export type ToolCandidateType = 'builtin' | 'mcp' | 'external';

export interface ToolCandidate {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  aliases?: string[];
  type?: ToolCandidateType;
  categoryPath?: string;
  /** Retrieval score (RRF, cosine or channel score) — the base of the ranking. */
  retrievalScore: number;
  /** 1-indexed position in the retrieval order; the retrieval tie-break. */
  retrievalRank: number;
}

export interface RankedTool extends ToolCandidate {
  /** Final ranking score (normalized retrieval base plus feature adjustments). */
  score: number;
  /** Short stable tags explaining the score, in the order they were applied. */
  reasons: string[];
  /** Family key used for primary/related grouping. */
  family: string;
}

export interface RankToolCandidatesOptions {
  /** Maximum number of related tools to return. Default 3. */
  relatedLimit?: number;
  /**
   * Pure re-ordering hook (never adds or drops entries) applied to the scored
   * order before family grouping, so `related` is always derived from the
   * final winner. `tool(op:search)` passes its bounded workspace-domain
   * preference here. A hook that returns anything other than a permutation
   * of its input is ignored.
   */
  reRank?: <T extends { id: string }>(list: T[]) => T[];
}

export interface RankedToolResult {
  /** Distinct-capability results, best first. */
  primary: RankedTool[];
  /** Same family as the top result but a different verb — alternatives, not answers. */
  related: RankedTool[];
  /** Query analysis, for `explain` output. */
  query: { verbs: VerbClass[]; objects: string[] };
}

type VerbClass = 'create' | 'read' | 'edit' | 'delete' | 'search' | 'export';

const VERB_CLASSES: Record<VerbClass, readonly string[]> = {
  create: ['create', 'new', 'make', 'add', 'draw', 'start', 'build'],
  read: ['get', 'read', 'show', 'view', 'open', 'fetch', 'look', 'inspect', 'load'],
  edit: ['edit', 'update', 'modify', 'change', 'apply', 'rename', 'set', 'move'],
  delete: ['delete', 'remove', 'archive', 'trash', 'clear'],
  search: ['search', 'find', 'lookup', 'query', 'list', 'discover'],
  export: ['export', 'render', 'download'],
};

const VERB_BY_TOKEN: ReadonlyMap<string, VerbClass> = (() => {
  const map = new Map<string, VerbClass>();
  for (const [cls, verbs] of Object.entries(VERB_CLASSES) as [VerbClass, readonly string[]][]) {
    for (const verb of verbs) map.set(verb, cls);
  }
  return map;
})();

/**
 * Words that carry no capability evidence. `tokenizeQuery` already drops
 * anything under three characters (a, an, or, to, of, in, my, …).
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'its',
  'are',
  'was',
  'into',
  'from',
  'some',
  'any',
  'all',
  'existing',
  'current',
  'please',
  'want',
  'need',
  'can',
  'could',
  'would',
  'should',
  'how',
  'does',
  'using',
  'use',
  'via',
  'then',
  'also',
  'just',
  'take',
  'let',
  'like',
  'help',
  'about',
  'what',
  'which',
  'where',
  'when',
  'there',
  'here',
  'them',
  'they',
  'you',
  'your',
  'our',
  'one',
  'tool',
  'tools',
]);

/** Feature weights, on the scale where the best retrieval score is 1.0. */
const WEIGHTS = {
  exactIdentity: 4,
  exactCover: 3,
  objectStrong: 1.5,
  objectWeak: 0.35,
  objectWeakCap: 0.7,
  verbPrimary: 1.5,
  verbSecondary: 0.75,
  verbKeyword: 0.5,
  verbConflict: -1,
  weakIncidental: -1.5,
  /** Relative band (of the competing MCP score) in which the prior applies. */
  firstPartyBand: 0.08,
} as const;

// Text helpers

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Identifier-aware tokens (camelCase, `_`, `-`, punctuation), ≥ 3 chars. */
function tokens(value: string): string[] {
  return tokenizeQuery(value.replace(/[^A-Za-z0-9]+/g, ' '));
}

/** Fold simple plurals so `files` matches `file` and `docs` matches `doc`. */
function stem(token: string): string {
  if (token.length <= 3) return token;
  if (/(ch|sh|x|z|s)es$/.test(token)) return token.slice(0, -2);
  if (/ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/[^s]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Verb class of a token in its exact base form (`create`, `get`, …). */
function exactVerbClass(token: string): VerbClass | undefined {
  return (
    VERB_BY_TOKEN.get(token) ??
    (token.endsWith('s') ? VERB_BY_TOKEN.get(token.slice(0, -1)) : undefined)
  );
}

/**
 * Verb class of an inflected form (`creating`, `edited`). Such a token may
 * equally be a noun (`drawing`), so callers keep it as an object as well.
 */
function foldedVerbClass(token: string): VerbClass | undefined {
  const forms: string[] = [];
  if (token.endsWith('ing')) forms.push(token.slice(0, -3), `${token.slice(0, -3)}e`);
  if (token.endsWith('ed')) forms.push(token.slice(0, -2), token.slice(0, -1));
  for (const form of forms) {
    const cls = VERB_BY_TOKEN.get(form);
    if (cls) return cls;
  }
  return undefined;
}

/** `mcp__<server>__<tool>` → `<tool>`; anything else unchanged. */
function localId(id: string): string {
  if (!id.startsWith('mcp__')) return id;
  const rest = id.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep === -1 ? rest : rest.slice(sep + 2);
}

function mcpServerOf(id: string): string | undefined {
  if (!id.startsWith('mcp__')) return undefined;
  const rest = id.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep === -1 ? rest : rest.slice(0, sep);
}

// Query analysis

interface QueryAnalysis {
  normalized: string;
  /** All non-stopword tokens (verbs included), original order. */
  content: string[];
  /** Verb classes in query order; the first is the primary intent. */
  verbs: VerbClass[];
  /** Object tokens (content minus verbs), stemmed, de-duplicated. */
  objects: string[];
}

function analyzeQuery(query: string): QueryAnalysis {
  const content = tokens(query).filter((t) => !STOPWORDS.has(t));
  const verbs: VerbClass[] = [];
  const objects: string[] = [];
  for (const token of content) {
    const exact = exactVerbClass(token);
    if (exact) {
      if (!verbs.includes(exact)) verbs.push(exact);
      continue;
    }
    const folded = foldedVerbClass(token);
    if (folded && !verbs.includes(folded)) verbs.push(folded);
    const s = stem(token);
    if (!objects.includes(s)) objects.push(s);
  }
  return { normalized: normalizeText(query), content, verbs, objects };
}

// Tool analysis

interface ToolAnalysis {
  idTokens: string[];
  /** Verb classes claimed by the id and display name. */
  primaryVerbs: Set<VerbClass>;
  /** Verb classes claimed only by keywords/aliases. */
  keywordVerbs: Set<VerbClass>;
  /** Stemmed words from id, name, keywords, aliases. */
  strong: Set<string>;
  /** Stemmed words from the description. */
  prose: Set<string>;
  normalizedId: string;
  normalizedLocalId: string;
  normalizedName: string;
}

function analyzeTool(tool: ToolCandidate): ToolAnalysis {
  const idTokens = tokens(localId(tool.id));
  const nameTokens = tokens(tool.name);
  const primaryVerbs = new Set<VerbClass>();
  for (const token of [...idTokens, ...nameTokens]) {
    const cls = exactVerbClass(token);
    if (cls) primaryVerbs.add(cls);
  }
  const keywordVerbs = new Set<VerbClass>();
  const strong = new Set<string>();
  for (const token of [...idTokens, ...nameTokens]) strong.add(stem(token));
  for (const entry of [...(tool.keywords ?? []), ...(tool.aliases ?? [])]) {
    for (const token of tokens(String(entry))) {
      strong.add(stem(token));
      const cls = exactVerbClass(token);
      if (cls && !primaryVerbs.has(cls)) keywordVerbs.add(cls);
    }
  }
  const prose = new Set<string>();
  for (const token of tokens(tool.description ?? '')) prose.add(stem(token));
  return {
    idTokens,
    primaryVerbs,
    keywordVerbs,
    strong,
    prose,
    normalizedId: normalizeText(tool.id),
    normalizedLocalId: normalizeText(localId(tool.id)),
    normalizedName: normalizeText(tool.name),
  };
}

// Scoring

interface Scored {
  tool: ToolCandidate;
  analysis: ToolAnalysis;
  score: number;
  reasons: string[];
  /** Count of positive evidence features — the first tie-break after score. */
  evidence: number;
  family: string;
  /**
   * The tool is a genuine capability match for the query (exact identity, or
   * verb agreement backed by a curated object hit) — the precondition for
   * demoting its siblings to `related`.
   */
  strongMatch: boolean;
}

function familyKey(tool: ToolCandidate, analysis: ToolAnalysis, query: QueryAnalysis): string {
  if (tool.type === 'mcp') {
    return tool.categoryPath ?? `integrations/${mcpServerOf(tool.id) ?? 'mcp'}`;
  }
  // Object tokens of the id (everything that is not a verb), preferring the
  // ones the query asked about so `get_event` groups with the other `*_event`
  // tools on an event query. Falls back to the category when the id is verb-only.
  const objectTokens = analysis.idTokens.map(stem).filter((t) => !exactVerbClass(t));
  const asked = objectTokens.filter((t) => query.objects.includes(t));
  const key = asked.length > 0 ? asked : objectTokens;
  if (key.length > 0) return `object:${[...new Set(key)].sort().join(' ')}`;
  return `category:${tool.categoryPath ?? tool.id}`;
}

function scoreCandidate(
  tool: ToolCandidate,
  query: QueryAnalysis,
  base: number,
  maxRetrieval: number
): Scored {
  const analysis = analyzeTool(tool);
  const reasons: string[] = [];
  let score = maxRetrieval > 0 ? base / maxRetrieval : 0;
  let evidence = 0;
  let exact = false;
  let verbAgreed = false;

  // Exact identity: the query names the tool.
  const q = query.normalized;
  const contentSet = new Set(query.content);
  if (q && (q === analysis.normalizedId || q === analysis.normalizedLocalId)) {
    score += WEIGHTS.exactIdentity;
    reasons.push('exact-id');
    evidence += 1;
    exact = true;
  } else if (q && q === analysis.normalizedName) {
    score += WEIGHTS.exactIdentity;
    reasons.push('exact-name');
    evidence += 1;
    exact = true;
  } else if (
    analysis.idTokens.length > 0 &&
    query.content.length > 0 &&
    analysis.idTokens.every((t) => contentSet.has(t) || query.objects.includes(stem(t)))
  ) {
    score += WEIGHTS.exactCover;
    reasons.push('exact-cover');
    evidence += 1;
    exact = true;
  }

  // Verb agreement.
  if (query.verbs.length > 0) {
    const primary = query.verbs[0];
    if (analysis.primaryVerbs.has(primary)) {
      score += WEIGHTS.verbPrimary;
      reasons.push(`verb:${primary}`);
      evidence += 1;
      verbAgreed = true;
    } else {
      const secondary = query.verbs.slice(1).find((v) => analysis.primaryVerbs.has(v));
      const viaKeyword = query.verbs.find((v) => analysis.keywordVerbs.has(v));
      if (secondary) {
        score += WEIGHTS.verbSecondary;
        reasons.push(`verb:${secondary}`);
        evidence += 1;
        verbAgreed = true;
      } else if (viaKeyword) {
        score += WEIGHTS.verbKeyword;
        reasons.push(`verb-keyword:${viaKeyword}`);
        evidence += 1;
        verbAgreed = true;
      } else if (analysis.primaryVerbs.size > 0) {
        score += WEIGHTS.verbConflict;
        reasons.push(`verb-conflict:${[...analysis.primaryVerbs].sort().join('|')}`);
      }
    }
  }

  // Object evidence.
  let strongHits = 0;
  let weakHits = 0;
  for (const object of query.objects) {
    if (analysis.strong.has(object)) {
      strongHits += 1;
      reasons.push(`object:${object}`);
    } else if (analysis.prose.has(object)) {
      weakHits += 1;
      reasons.push(`object-in-description-only:${object}`);
    }
  }
  score += strongHits * WEIGHTS.objectStrong;
  score += Math.min(weakHits * WEIGHTS.objectWeak, WEIGHTS.objectWeakCap);
  evidence += strongHits + weakHits;

  // Weak incidental: the query asked about something and this tool has no
  // curated claim to it. Keeps prose-only / zero-hit candidates below any
  // candidate with a single strong hit, whatever retrieval thought.
  if (query.objects.length > 0 && strongHits === 0) {
    score += WEIGHTS.weakIncidental;
    reasons.push('weak-incidental-penalty');
  }

  return {
    tool,
    analysis,
    score,
    reasons,
    evidence,
    family: familyKey(tool, analysis, query),
    strongMatch: exact || (verbAgreed && strongHits > 0),
  };
}

function compareScored(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.evidence !== a.evidence) return b.evidence - a.evidence;
  if (a.tool.retrievalRank !== b.tool.retrievalRank) {
    return a.tool.retrievalRank - b.tool.retrievalRank;
  }
  return a.tool.id < b.tool.id ? -1 : a.tool.id > b.tool.id ? 1 : 0;
}

function verbSignature(analysis: ToolAnalysis): string[] {
  return analysis.primaryVerbs.size > 0 ? [...analysis.primaryVerbs].sort() : ['none'];
}

/**
 * Apply the caller's pure re-ordering hook to the scored order. Entries whose
 * position changed are tagged `rerank-shift:<delta>` so `explain` output shows
 * the move. Anything that is not a permutation of the input is ignored.
 */
function applyReRank(scored: Scored[], reRank: RankToolCandidatesOptions['reRank']): Scored[] {
  if (!reRank || scored.length < 2) return scored;
  const byId = new Map(scored.map((s, i) => [s.tool.id, { s, i }]));
  const reordered = reRank(scored.map((s) => ({ id: s.tool.id })));
  if (reordered.length !== scored.length) return scored;
  const seen = new Set<string>();
  const out: Scored[] = [];
  for (let i = 0; i < reordered.length; i += 1) {
    const entry = byId.get(reordered[i].id);
    if (!entry || seen.has(reordered[i].id)) return scored;
    seen.add(reordered[i].id);
    if (entry.i !== i) {
      const delta = entry.i - i;
      entry.s.reasons.push(`rerank-shift:${delta > 0 ? '+' : ''}${delta}`);
    }
    out.push(entry.s);
  }
  return out;
}

function toRanked(s: Scored): RankedTool {
  return {
    ...s.tool,
    score: Math.round(s.score * 1000) / 1000,
    reasons: s.reasons,
    family: s.family,
  };
}

/**
 * Rank retrieval candidates for a query.
 *
 * `primary` holds distinct capabilities best-first; `related` holds tools
 * from the top result's family that do a different thing (e.g. `get_event`
 * when `create_event` won), capped at `relatedLimit`.
 */
export function rankToolCandidates(
  candidates: ToolCandidate[],
  query: string,
  options: RankToolCandidatesOptions = {}
): RankedToolResult {
  const relatedLimit = options.relatedLimit ?? 3;
  const analysis = analyzeQuery(query);
  if (candidates.length === 0) {
    return {
      primary: [],
      related: [],
      query: { verbs: analysis.verbs, objects: analysis.objects },
    };
  }

  const maxRetrieval = Math.max(
    0,
    ...candidates.map((c) => (Number.isFinite(c.retrievalScore) ? c.retrievalScore : 0))
  );
  const scored = candidates.map((c) =>
    scoreCandidate(
      c,
      analysis,
      Number.isFinite(c.retrievalScore) ? c.retrievalScore : 0,
      maxRetrieval
    )
  );

  // First-party prior: decides near-ties against MCP candidates only, and only
  // for Snaglet's own builtin tools — external and unknown-type candidates get no
  // prior. A builtin within the band below the best MCP candidate is lifted
  // just above it; one that trails by more keeps its place.
  const bestMcp = scored
    .filter((s) => s.tool.type === 'mcp')
    .reduce<
      number | undefined
    >((best, s) => (best === undefined || s.score > best ? s.score : best), undefined);
  if (bestMcp !== undefined) {
    const band = WEIGHTS.firstPartyBand * Math.max(Math.abs(bestMcp), 1);
    for (const s of scored) {
      if (s.tool.type !== 'builtin') continue;
      const gap = bestMcp - s.score;
      if (gap >= 0 && gap <= band) {
        s.score += band + 0.01;
        s.reasons.push('first-party-prior');
      }
    }
  }

  scored.sort(compareScored);
  const ordered = applyReRank(scored, options.reRank);

  // Family grouping only when the winner is a genuine capability match: on a
  // weak or nonspecific query there is no "answer" whose siblings would be
  // mere alternatives, so every candidate stays primary.
  const top = ordered[0];
  const topVerbs = verbSignature(top.analysis);
  const primary: Scored[] = [top];
  const related: Scored[] = [];
  for (const s of ordered.slice(1)) {
    const sameFamily = s.family === top.family;
    const sameVerb = verbSignature(s.analysis).some((v) => topVerbs.includes(v));
    if (top.strongMatch && sameFamily && !sameVerb) {
      s.reasons.push(`family:${top.family.replace(/^(object|category):/, '')}`);
      related.push(s);
    } else {
      primary.push(s);
    }
  }

  return {
    primary: primary.map(toRanked),
    related: related.slice(0, relatedLimit).map(toRanked),
    query: { verbs: analysis.verbs, objects: analysis.objects },
  };
}
