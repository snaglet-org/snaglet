/**
 * Canonical lexical query construction for the persisted `search_text` columns
 * defined in the initial schema.
 *
 * Every stored vector has a matching query form, and getting the pair wrong
 * fails SILENTLY — a configuration mismatch returns zero rows with no error.
 * These helpers exist so the pairing is written once and cannot drift between
 * the workspace, palette, and node-search entry points.
 *
 * Ground truth behind these shapes, measured against PostgreSQL 17.10 rather
 * than assumed:
 *
 *   - The text-search parser treats a path as ONE token:
 *     `to_tsvector('simple', 'src/index.ts')` → the single lexeme
 *     `src/index.ts`. Indexing or querying only that form means `index.ts`
 *     never finds its own file.
 *   - `websearch_to_tsquery('simple', 'file_read')` → `'file' <-> 'read'`;
 *     underscores split on both sides, so identifiers behave sensibly.
 *   - A `simple` vector does not match an `english` query for unstemmed words:
 *     the tools vector stores `lines` (simple), while
 *     `websearch_to_tsquery('english', 'lines')` asks for `line`. Identifier
 *     lanes must therefore query `simple`, and anything mixing identifiers
 *     with prose must query both.
 */

/**
 * Separators translated to spaces so each path segment becomes its own lexeme.
 * Must stay identical to the schema's `files.search_text` expression — the
 * index and the query have to agree on what a segment is.
 */
const PATH_SEPARATORS = String.raw`/\.-_`;
const PATH_SEPARATOR_SPACES = ' '.repeat(PATH_SEPARATORS.length);

/**
 * Tools: identity/aliases/keywords are indexed `simple`, the description
 * `english`. OR-ing both query configurations is what lets `lines` match a
 * curated keyword and `filesystem` match description prose in one predicate.
 */
export function toolTsQuery(param: string): string {
  return `(websearch_to_tsquery('simple', ${param}) || websearch_to_tsquery('english', ${param}))`;
}

/**
 * File paths: the query is expanded exactly the way the column is, so a whole
 * path, a bare segment, and a dotted filename all match the same row.
 * Without the translated arm, `index.ts` parses to one lexeme that appears in
 * neither half of the stored vector.
 */
export function filePathTsQuery(param: string): string {
  return (
    `(websearch_to_tsquery('simple', ${param}) || ` +
    `websearch_to_tsquery('simple', translate(${param}, '${PATH_SEPARATORS}', '${PATH_SEPARATOR_SPACES}')))`
  );
}

const MAX_TYPEAHEAD_WORDS = 8;

/**
 * The words of a type-ahead query (letters and digits only, lowercased) for
 * {@link titleWordsPrefixSql}. Punctuation separates words and is dropped.
 */
export function typeaheadWords(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TYPEAHEAD_WORDS);
}

/**
 * Type-ahead title match: every typed word starts a word of the title, in
 * any order and any case. A stemmed tsquery has no prefix form, so
 * `automations rech` finds nothing while the last word is half typed; this
 * finds "Automations recheck". `wordsParam` binds {@link typeaheadWords}'
 * `text[]`; those words are letters and digits only, so they are safe inside
 * the pattern.
 */
export function titleWordsPrefixSql(titleExpression: string, wordsParam: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM unnest(${wordsParam}::text[]) AS typed(word) ` +
    `WHERE NOT (${titleExpression} ~* ('(^|[^[:alnum:]])' || typed.word)))`
  );
}

/**
 * Weight vector for `ts_rank_cd(weights, vector, query)`, ordered {D, C, B, A}.
 * Matches PostgreSQL's documented defaults; stated explicitly because the
 * tools lane depends on the ordering being A=identity, B=keywords,
 * C=description, and a silent default change would re-rank the catalog.
 */
const RANK_WEIGHTS = `'{0.1, 0.2, 0.4, 1.0}'::float4[]`;

/** Weighted relevance for a stored vector. Never a constant, never recomputed. */
export function rankCd(vectorExpression: string, tsQueryExpression: string): string {
  return `ts_rank_cd(${RANK_WEIGHTS}, ${vectorExpression}, ${tsQueryExpression})`;
}
