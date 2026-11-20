import { View } from '@snaglet/db/View';
import { vectorLiteral } from '@snaglet/shared/utils';
import { Tools } from './ToolModel';
import { tokenizeQuery } from './tokenize';

export { tokenizeQuery } from './tokenize';

export interface ToolSearchEntry {
  id: string;
  name: string;
  description: string;
  /** 'builtin' | 'mcp' | 'external' — lets search ranking apply its first-party prior. */
  type?: string;
  category_path: string;
  provider_id?: string | null;
  parameters_schema: Record<string, unknown>;
  tier: string;
  keywords: string[];
  aliases?: string[];
}

interface SemanticToolHit extends ToolSearchEntry {
  /** Cosine similarity in [0,1] — 1 = identical, 0 = orthogonal. */
  score: number;
}

export interface ToolDetailResult {
  id: string;
  name: string;
  description: string;
  type: string;
  tier: string;
  category_path: string;
  provider_id: string | null;
  parameters_schema: Record<string, unknown>;
  keywords: string[];
  aliases: string[];
  source: string | null;
}

export class ToolView extends View<typeof Tools> {
  constructor() {
    super({ model: Tools });
  }

  /**
   * Full detail for a single tool — schema, docs, error codes.
   */
  async toolDetail(toolId: string): Promise<ToolDetailResult | null> {
    return Tools.queryOne<ToolDetailResult>(
      `SELECT id, name, description, type, tier, category_path, provider_id,
              parameters_schema, keywords,
              COALESCE(aliases, '{}'::text[]) AS aliases,
              source
       FROM tools
       WHERE id = $1 AND enabled = true
       LIMIT 1`,
      [toolId]
    );
  }

  /**
   * Keyword search across tool names, descriptions, keywords, and aliases.
   * Used by the `tool(op:search)` discovery handler for query-based search.
   *
   * One relevance ranking over a pooled candidate set, with two generic
   * signals:
   *
   *   Information content: each query token is weighted by inverse document
   *   frequency across the live catalog, so a token nearly every tool
   *   mentions ("file", "show", "the") carries almost no weight and a rare
   *   one ("lines", "cron") carries a lot. No hand-written stop list.
   *
   *   Evidence strength: where a token matches matters. A curated keyword or
   *   alias outweighs a word in prose; exact whole-query matches and phrase
   *   containment score above scattered token overlap.
   *
   * Ties break on evidence quality first and on name order only as the final,
   * deterministic step. Candidates pool whole-query substring matches,
   * per-token matches and `tokenizeQuery`'s identifier-style splitting (so a
   * hallucinated `library_page_read` still finds `library_get_page`).
   */
  async searchByKeyword(
    query: string,
    limit = 50
  ): Promise<{
    tools: ToolSearchEntry[];
    count: number;
  }> {
    const phrase = normalizeToolText(query);
    const tokens = queryTokens(query);
    if (!phrase && tokens.length === 0) return { tools: [], count: 0 };

    // The ranking corpus: every enabled tool's searchable text. IDF is only
    // meaningful over the whole catalog, not over the matches — a token cannot
    // be recognized as uninformative by looking at the rows it selected. The
    // table is small (<200 rows) and heavyweight columns (parameters_schema)
    // are deliberately excluded; the full rows are fetched once for winners.
    const corpus = await Tools.query<ToolRankingRow>(
      `SELECT id, name, description,
              COALESCE(keywords, '{}'::text[]) AS keywords,
              COALESCE(aliases, '{}'::text[]) AS aliases
       FROM tools
       WHERE enabled = true`
    );
    if (corpus.length === 0) return { tools: [], count: 0 };

    const documents = corpus.map(buildToolDocument);
    const idf = inverseDocumentFrequency(documents, tokens);

    const ranked = documents
      .map((document) => scoreToolDocument(document, phrase, tokens, idf))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          // Evidence quality before spelling: a tool that matched on curated
          // keywords outranks one that merely mentioned the words in prose.
          b.strongHits - a.strongHits ||
          b.matchedTokens - a.matchedTokens ||
          a.name.localeCompare(b.name)
      )
      .slice(0, limit);

    if (ranked.length === 0) return { tools: [], count: 0 };

    // Rehydrate the winners with the full projection callers expect, then put
    // them back in ranked order (SQL returns them unordered).
    const rows = await Tools.query<ToolSearchEntry>(
      `SELECT id, name, description, type, category_path, provider_id, parameters_schema, tier, keywords, aliases
       FROM tools
       WHERE enabled = true AND id = ANY($1::text[])`,
      [ranked.map((candidate) => candidate.id)]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const tools = ranked
      .map((candidate) => byId.get(candidate.id))
      .filter((row): row is ToolSearchEntry => row !== undefined);

    return { tools, count: tools.length };
  }

  /**
   * Semantic search over tools using pgvector cosine similarity.
   *
   * Takes a pre-computed query embedding (callers embed the user's text via
   * `generateEmbedding`) and ranks active tools by cosine similarity against
   * their stored vectors in `public.embeddings`. Returns only tools that have
   * an embedding row — tools without vectors (sync hasn't run, or worker
   * hasn't ticked) are silently skipped.
   *
   * Defaults reflect agent-prompt economics: keep top-N small and drop
   * low-confidence matches so the tool's response stays compact and the
   * downstream agent's context doesn't fill with noisy tail results.
   *
   * Threshold calibrated against text-embedding-3-small: strong matches land
   * 0.50–0.65, plausible 0.35–0.50, noise <0.30. It sits just above the noise
   * floor so a tool with no good semantic match returns
   * empty (callers fall back to keyword) instead of returning the top of a
   * noise cluster.
   */
  async semanticSearch(
    embedding: number[],
    limit = 3,
    minScore = 0.3,
    modelId?: string
  ): Promise<{
    tools: SemanticToolHit[];
    count: number;
  }> {
    // Filter stored tool vectors to the active embedding model's rows only.
    // Without this, a query embedded with one model (e.g. 768d) is compared
    // against vectors written by a different model (e.g. 1536d), and pgvector
    // throws "different vector dimensions 1536 and 768". Mirrors the
    // model_id-scoped filter in workspace-search/semantic.ts.
    const rows = await Tools.query<SemanticToolHit>(
      `SELECT
         t.id,
         t.name,
         t.description,
         t.type,
         t.category_path,
         t.provider_id,
         t.parameters_schema,
         t.tier,
         COALESCE(t.keywords, '{}'::text[]) AS keywords,
         COALESCE(t.aliases, '{}'::text[]) AS aliases,
         (1 - e.distance)::real AS score
       FROM tools t
       JOIN public.nodes n ON n.id = t.id AND n.type = 'tool'
       JOIN (
         -- Best-chunk-per-node aggregation (chunked embeddings store one
         -- row per chunk; tools are short so this is usually 1:1).
         SELECT node_id, MIN(vector <=> $1::vector) AS distance
         FROM public.embeddings
         WHERE ($4::text IS NULL OR model_id = $4)
         GROUP BY node_id
       ) e ON e.node_id = t.id
       WHERE t.enabled = true
         AND (1 - e.distance) >= $3
       ORDER BY e.distance
       LIMIT $2`,
      [vectorLiteral(embedding), limit, minScore, modelId ?? null]
    );
    return { tools: rows, count: rows.length };
  }
}

// tokenizeQuery lives in ./tokenize.ts so it can be unit-tested without
// pulling DB code into the test runtime. Re-exported above for callers
// that import it from this module.

/** A tool reduced to the fields keyword relevance is computed from. */
interface ToolRankingRow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  aliases: string[];
}

interface ToolDocument {
  id: string;
  name: string;
  /** Curated intent statements: keywords + aliases, normalized. */
  strong: Set<string>;
  /** Words of the tool's display name. */
  nameWords: Set<string>;
  /** Words of the description prose. */
  proseWords: Set<string>;
  namePhrase: string;
  prosePhrase: string;
  /** Union of everything above — the unit of document frequency. */
  all: Set<string>;
}

/**
 * How much each kind of evidence is worth, multiplied by the token's
 * information content.
 *
 * A keyword or alias is an author's explicit claim about what the tool is for.
 * A name word is nearly as strong. Description prose is corroboration: real
 * signal, but a tool that merely *mentions* a word should not outrank one
 * built for it.
 */
const EVIDENCE_WEIGHT = { strong: 3, name: 2.5, prose: 1 } as const;
/** A tool whose whole identity is the query (`file_read` ⇢ "file read"). */
const EXACT_PHRASE_BONUS = 6;
/** The full query appearing intact in the name, then in the prose. */
const NAME_PHRASE_BONUS = 3;
const PROSE_PHRASE_BONUS = 1.5;
/** Substring credit for tokens that match no whole word (`log` in `logger`). */
const PARTIAL_NAME_WEIGHT = 1.2;
/**
 * Floor added to every token's information content.
 *
 * A token present in every tool has an IDF of exactly 0. Without this floor a
 * query built only from such words would score every tool 0 and return
 * nothing at all. The floor is small enough that one informative token still
 * outweighs any number of ubiquitous ones, and large enough that evidence
 * strength continues to order otherwise-equal tools.
 */
const TOKEN_WEIGHT_FLOOR = 0.05;

/** Lowercase, strip punctuation to spaces, collapse runs. */
function normalizeToolText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function wordSet(value: string): Set<string> {
  const normalized = normalizeToolText(value);
  return new Set(normalized ? normalized.split(' ') : []);
}

/**
 * Query tokens for ranking.
 *
 * Unions `tokenizeQuery`'s identifier-aware splitting (camelCase and `_`/`-`
 * boundaries, which is what lets a hallucinated tool name match a real one)
 * with a punctuation split, so `package.json` and `src/index.ts` contribute
 * `package`/`json`/`src`/`index` instead of arriving as one unmatchable blob.
 * `tokenizeQuery` itself is left alone — it is exported and separately
 * specified, and widening its contract would change every other caller.
 */
function queryTokens(query: string): string[] {
  const tokens = new Set<string>(tokenizeQuery(query));
  for (const word of normalizeToolText(query).split(' ')) {
    // Same 3-char floor tokenizeQuery applies: shorter fragments are noise.
    if (word.length >= 3) tokens.add(word);
  }
  return [...tokens];
}

function buildToolDocument(row: ToolRankingRow): ToolDocument {
  const strong = new Set<string>();
  for (const entry of [...(row.keywords ?? []), ...(row.aliases ?? [])]) {
    const normalized = normalizeToolText(String(entry));
    if (!normalized) continue;
    // A multi-word keyword contributes both the phrase and its words.
    strong.add(normalized);
    for (const word of normalized.split(' ')) strong.add(word);
  }
  const nameWords = wordSet(row.name);
  const proseWords = wordSet(row.description ?? '');
  return {
    id: row.id,
    name: row.name,
    strong,
    nameWords,
    proseWords,
    namePhrase: normalizeToolText(row.name),
    prosePhrase: normalizeToolText(row.description ?? ''),
    all: new Set([...strong, ...nameWords, ...proseWords]),
  };
}

/**
 * Information content per query token, measured against the live catalog.
 *
 * `log((N + 1) / (df + 1))` — a token every tool contains scores 0 and drops
 * out of ranking entirely, which is precisely the behavior wanted for
 * instruction words and for domain words so generic they cannot discriminate
 * ("file" across a file-tool suite). Rare tokens dominate. Nothing here is
 * specific to a query or a tool; changing the catalog re-derives the weights.
 */
function inverseDocumentFrequency(
  documents: ToolDocument[],
  tokens: string[]
): Map<string, number> {
  const total = documents.length;
  const idf = new Map<string, number>();
  for (const token of tokens) {
    let frequency = 0;
    for (const document of documents) if (document.all.has(token)) frequency += 1;
    idf.set(token, Math.log((total + 1) / (frequency + 1)));
  }
  return idf;
}

interface ScoredToolDocument {
  id: string;
  name: string;
  score: number;
  /** Tokens matched against curated keywords/aliases — the quality signal. */
  strongHits: number;
  matchedTokens: number;
}

function scoreToolDocument(
  document: ToolDocument,
  phrase: string,
  tokens: string[],
  idf: Map<string, number>
): ScoredToolDocument {
  let score = 0;
  let strongHits = 0;
  let matchedTokens = 0;

  for (const token of tokens) {
    const weight = idf.get(token) ?? 0;
    let evidence = 0;
    if (document.strong.has(token)) {
      evidence = EVIDENCE_WEIGHT.strong;
      strongHits += 1;
    } else if (document.nameWords.has(token)) {
      evidence = EVIDENCE_WEIGHT.name;
    } else if (document.proseWords.has(token)) {
      evidence = EVIDENCE_WEIGHT.prose;
    } else if (document.namePhrase.includes(token)) {
      evidence = PARTIAL_NAME_WEIGHT;
    }
    if (evidence > 0) {
      matchedTokens += 1;
      score += evidence * (weight + TOKEN_WEIGHT_FLOOR);
    }
  }

  if (phrase) {
    if (document.strong.has(phrase) || document.namePhrase === phrase) {
      score += EXACT_PHRASE_BONUS;
      strongHits += 1;
    } else if (document.namePhrase.includes(phrase)) {
      score += NAME_PHRASE_BONUS;
    } else if (document.prosePhrase.includes(phrase)) {
      score += PROSE_PHRASE_BONUS;
    }
  }

  return { id: document.id, name: document.name, score, strongHits, matchedTokens };
}

export const toolView = new ToolView();
