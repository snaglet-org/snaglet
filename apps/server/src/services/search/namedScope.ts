/**
 * Named-project scope — `... in "Project Name"` / `... in Project Name`.
 *
 * A project name in the query must scope the search, not stay in the search
 * term with results coming back from every project at once. This module
 * supplies the two pieces that make it a scope — a trailing-phrase parser and
 * an exact name resolver — so the route can hand a real project id to the
 * scoping SQL.
 *
 * Two forms, deliberately asymmetric:
 *
 *   `in "Project Name"`  QUOTED — an explicit, unambiguous request for scope.
 *                        If it does not resolve, that is an error. Falling back
 *                        to a whole-workspace search would answer a question
 *                        the user did not ask and look like success.
 *
 *   `in Project Name`    UNQUOTED — scope only when the trailing text resolves
 *                        exactly to one project. Ordinary English contains
 *                        " in " constantly ("notes in progress"), so an
 *                        unresolvable name is plain search text, not an error.
 *
 * The split is what makes the unquoted form safe: it can only ever engage when
 * a project by that exact name exists, and the quoted form gives the user a way
 * to demand scope and be TOLD when it is not available.
 *
 * Resolution is case-insensitive exact match. Two projects whose names differ
 * only by case are ambiguous, not a coin flip.
 */

import { getDb } from '@snaglet/db';

/** One way of splitting a query into `<residual> in <name>`. */
type ScopePhraseCandidate = {
  /** The project name as written, trimmed. */
  name: string;
  /** The query with the scope phrase removed. Never empty — see parse notes. */
  residual: string;
};

export type ParsedScopePhrase = {
  quoted: boolean;
  /**
   * Splits to try, in resolution order. Only the unquoted form produces more
   * than one: `a in b in c` could mean project "c" or project "b in c", so both
   * are offered and the first that resolves wins.
   */
  candidates: ScopePhraseCandidate[];
};

/** Straight and curly quotes — macOS substitutes curly ones while typing. */
const QUOTED_SCOPE_RE = /\s\bin\s+["“]([^"“”]+)["”]\s*$/i;
const UNQUOTED_SEPARATOR_RE = /\s+\bin\s+/gi;

/** Longest project name we will look up. Bounds the parameter, not the schema. */
const MAX_SCOPE_NAME_LENGTH = 200;
/** Cap on `a in b in c in d ...` splits, so one query stays one small query. */
const MAX_UNQUOTED_CANDIDATES = 4;

function usableCandidate(name: string, residual: string): ScopePhraseCandidate | null {
  const trimmedName = name.trim();
  const trimmedResidual = residual.trim();
  if (!trimmedName || trimmedName.length > MAX_SCOPE_NAME_LENGTH) return null;
  // A phrase with nothing in front of it ("in Snaglet") would leave an EMPTY search
  // term under strict scope. The empty-query path in paletteSearch browses by
  // kind and does not apply scope at all, so that combination would quietly
  // return unscoped rows under a `strict` label — the exact leak this feature
  // exists to close. Treat it as ordinary text instead.
  if (!trimmedResidual) return null;
  return { name: trimmedName, residual: trimmedResidual };
}

/**
 * Split a trailing scope phrase off `query`. Pure — no database, no I/O.
 *
 * Returns null when the query contains no usable phrase, in which case the
 * caller searches the query verbatim.
 */
export function parseTrailingScopePhrase(query: string): ParsedScopePhrase | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const quoted = QUOTED_SCOPE_RE.exec(trimmed);
  if (quoted) {
    const candidate = usableCandidate(quoted[1], trimmed.slice(0, quoted.index));
    return candidate ? { quoted: true, candidates: [candidate] } : null;
  }

  // An unbalanced quote is someone mid-type (`in "Snaglet`). Do not guess at scope
  // from a half-written phrase and do not error on it — it is still being said.
  if (/\s\bin\s+["“]/i.test(trimmed)) return null;

  const splits: ScopePhraseCandidate[] = [];
  UNQUOTED_SEPARATOR_RE.lastIndex = 0;
  for (let match = UNQUOTED_SEPARATOR_RE.exec(trimmed); match; ) {
    const candidate = usableCandidate(
      trimmed.slice(match.index + match[0].length),
      trimmed.slice(0, match.index)
    );
    if (candidate) splits.push(candidate);
    match = UNQUOTED_SEPARATOR_RE.exec(trimmed);
  }
  if (splits.length === 0) return null;

  // Rightmost separator first: in `notes in progress in Snaglet` the user almost
  // certainly means the project "Snaglet", not one called "progress in Snaglet". The
  // longer readings stay available for a project whose name contains " in ".
  return { quoted: false, candidates: splits.reverse().slice(0, MAX_UNQUOTED_CANDIDATES) };
}

type NamedProjectMatch = { projectId: string; projectName: string };

export type NamedScopeResolution =
  /** No phrase, or an unquoted phrase that names no project: search verbatim. */
  | { status: 'none' }
  | ({ status: 'resolved'; residualQuery: string } & NamedProjectMatch)
  | { status: 'not_found'; name: string }
  | { status: 'ambiguous'; name: string; matches: NamedProjectMatch[] };

type ProjectNameRow = { id: string; name: string };

async function findProjectsByExactName(names: string[]): Promise<Map<string, NamedProjectMatch[]>> {
  const byLoweredName = new Map<string, NamedProjectMatch[]>();
  if (names.length === 0) return byLoweredName;

  const { rows } = await getDb().query<ProjectNameRow>(
    `SELECT n.id, c.name
       FROM public.containers c
       JOIN public.nodes n ON n.id = c.id
      WHERE c.category = 'project'
        AND n.archived = false
        AND lower(btrim(c.name)) = ANY($1::text[])
      ORDER BY c.name ASC, n.id ASC`,
    [names.map((name) => name.trim().toLowerCase())]
  );

  for (const row of rows) {
    const key = row.name.trim().toLowerCase();
    const bucket = byLoweredName.get(key);
    const match = { projectId: row.id, projectName: row.name };
    if (bucket) bucket.push(match);
    else byLoweredName.set(key, [match]);
  }
  return byLoweredName;
}

/**
 * Resolve a trailing scope phrase in `query` to exactly one project.
 *
 * All candidate names are looked up in a single query; the first candidate with
 * a match decides the outcome. A candidate matching more than one project is
 * ambiguous in both forms — picking one would silently search somewhere the
 * user cannot see.
 */
export async function resolveNamedProjectScope(query: string): Promise<NamedScopeResolution> {
  const parsed = parseTrailingScopePhrase(query);
  if (!parsed) return { status: 'none' };

  const matchesByName = await findProjectsByExactName(parsed.candidates.map((c) => c.name));

  for (const candidate of parsed.candidates) {
    const matches = matchesByName.get(candidate.name.toLowerCase()) ?? [];
    if (matches.length === 1) {
      return { status: 'resolved', residualQuery: candidate.residual, ...matches[0] };
    }
    if (matches.length > 1) {
      return { status: 'ambiguous', name: candidate.name, matches };
    }
  }

  // Nothing matched. A quoted phrase asked for scope explicitly and must be
  // told it is unavailable; an unquoted one was probably just English.
  return parsed.quoted
    ? { status: 'not_found', name: parsed.candidates[0].name }
    : { status: 'none' };
}
